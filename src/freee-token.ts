// freeeのアクセストークンをD1で持ち、失効したら更新する。
//
// なぜD1に持つのか: freeeのリフレッシュトークンは**使うたびに入れ替わる**ため、
// 実行中に書き換えられないWorkers Secretsには置けない。
//
// なぜロックが要るのか: Workersは並行実行される。2つのリクエストが同時に更新すると、
// 先に成功したほうが古いリフレッシュトークンを無効化し、**あとから来たほうが死ぬ**。
// 死ぬとブラウザでの再認可からやり直しになる（2026-09-08に実際に踏んだ）。

const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';

// アクセストークンの寿命は6時間。期限ちょうどを狙わず、手前で更新する。
const REFRESH_MARGIN_SECONDS = 5 * 60;
// 更新中に落ちても永久ロックにならないよう、リースに期限を持たせる。
const LOCK_LEASE_SECONDS = 30;

export interface TokenEnv {
  DB: D1Database;
  FREEE_CLIENT_ID?: string;
  FREEE_CLIENT_SECRET?: string;
}

interface TokenRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
}

export class FreeeTokenError extends Error {}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function readRow(env: TokenEnv): Promise<TokenRow | null> {
  return env.DB.prepare(
    'SELECT access_token, refresh_token, expires_at FROM freee_tokens WHERE id = 1'
  ).first<TokenRow>();
}

function isFresh(row: TokenRow, now: number): boolean {
  const expiresAt = Math.floor(Date.parse(row.expires_at) / 1000);
  return Number.isFinite(expiresAt) && expiresAt - REFRESH_MARGIN_SECONDS > now;
}

/**
 * リースを取る。取れたのは changes=1 を得た実行だけ。
 * 取れなかった側は更新せず、先に取った側が書き終えるのを待って読み直す。
 */
async function acquireLock(env: TokenEnv, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE freee_tokens SET refreshing_until = ?
      WHERE id = 1 AND (refreshing_until IS NULL OR refreshing_until < ?)`
  )
    .bind(toIso(now + LOCK_LEASE_SECONDS), toIso(now))
    .run();
  return result.meta.changes === 1;
}

async function releaseLock(env: TokenEnv): Promise<void> {
  await env.DB.prepare('UPDATE freee_tokens SET refreshing_until = NULL WHERE id = 1').run();
}

async function refresh(env: TokenEnv, row: TokenRow): Promise<TokenRow> {
  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET) {
    throw new FreeeTokenError('FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が設定されていません');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
    }),
  });

  if (!res.ok) {
    // 応答本文にはトークンが載りうるので、そのままログへ流さない。
    const code = res.status;
    throw new FreeeTokenError(
      code === 400
        ? 'リフレッシュに失敗（invalid_grant の可能性）。ブラウザでの再認可が要る'
        : `リフレッシュに失敗: HTTP ${code}`
    );
  }

  const payload = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token || !payload.refresh_token) {
    throw new FreeeTokenError('応答にトークンが含まれていない');
  }

  const expiresAt = toIso(nowSeconds() + (payload.expires_in ?? 6 * 60 * 60));
  // 新しいリフレッシュトークンを保存し損ねると次の更新ができなくなる。
  // 失うと戻せないほうを先に書く。
  await env.DB.prepare(
    `UPDATE freee_tokens
        SET access_token = ?, refresh_token = ?, expires_at = ?, refreshing_until = NULL
      WHERE id = 1`
  )
    .bind(payload.access_token, payload.refresh_token, expiresAt)
    .run();

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_at: expiresAt,
  };
}

/** 使えるアクセストークンを返す。期限が近ければ更新する。 */
export async function getAccessToken(env: TokenEnv): Promise<string> {
  const row = await readRow(env);
  if (!row) throw new FreeeTokenError('freee_tokens が空。初回の認可がまだ行われていない');

  const now = nowSeconds();
  if (isFresh(row, now)) return row.access_token;

  if (!(await acquireLock(env, now))) {
    // 別の実行が更新中。こちらは更新せず、書き終わったものを読み直す。
    const updated = await readRow(env);
    if (updated && isFresh(updated, nowSeconds())) return updated.access_token;
    throw new FreeeTokenError('別の実行がトークンを更新中。少し待って再試行してください');
  }

  try {
    const refreshed = await refresh(env, row);
    return refreshed.access_token;
  } catch (e) {
    await releaseLock(env);
    throw e;
  }
}
