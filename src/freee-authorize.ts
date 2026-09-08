// 初回認可と再認可。認可コードをトークンへ交換し、D1へ保存する。
//
// なぜWorker側でやるのか: トークンをローカルのファイルやコマンド行に置かずに済むため。
// freeeのリフレッシュトークンは失効するとブラウザ認可からやり直しになるので、
// この経路は一度きりではなく、運用中に何度も使う。

import type { TokenEnv } from './freee-token';

const AUTHORIZE_URL = 'https://accounts.secure.freee.co.jp/public_api/authorize';
const TOKEN_URL = 'https://accounts.secure.freee.co.jp/public_api/token';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

export class FreeeAuthorizeError extends Error {}

/** ブラウザで開く認可URLを組み立てる。client_idはOAuthの仕様上URLへ載る。 */
export function buildAuthorizeUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** 認可コードをトークンへ交換し、D1へ保存する。値はログにも応答にも出さない。 */
export async function exchangeAndStore(env: TokenEnv, code: string): Promise<{ expiresAt: string }> {
  if (!env.FREEE_CLIENT_ID || !env.FREEE_CLIENT_SECRET) {
    throw new FreeeAuthorizeError('FREEE_CLIENT_ID / FREEE_CLIENT_SECRET が設定されていません');
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.FREEE_CLIENT_ID,
      client_secret: env.FREEE_CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  if (!res.ok) {
    // 応答本文には認可コードやトークンが載りうるので、そのまま返さない。
    throw new FreeeAuthorizeError(
      res.status === 400
        ? '交換に失敗（コードが使用済み・期限切れ・リダイレクトURI不一致のいずれか）'
        : `交換に失敗: HTTP ${res.status}`
    );
  }

  const payload = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token || !payload.refresh_token) {
    throw new FreeeAuthorizeError('応答にトークンが含まれていない');
  }

  const expiresAt = new Date(Date.now() + (payload.expires_in ?? 6 * 60 * 60) * 1000).toISOString();

  // 1行しか持たない。再認可のたびに置き換える。
  await env.DB.prepare(
    `INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at, refreshing_until)
     VALUES (1, ?, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       refreshing_until = NULL`
  )
    .bind(payload.access_token, payload.refresh_token, expiresAt)
    .run();

  return { expiresAt };
}
