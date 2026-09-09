import { verifyStripeSignature } from './stripe-signature';
import { buildJournalFromEvent, JournalError, type JournalDraft, type JournalLine, type StripeEvent } from './journal';
import { FreeePostError, postJournal, type PostEnv } from './freee-post';
import { buildAuthorizeUrl, exchangeAndStore, FreeeAuthorizeError } from './freee-authorize';
import { getAccessToken } from './freee-token';
import { fetchChargeFee, StripeApiError, type StripeApiEnv } from './stripe-api';
import { notifyIfFindings, reconcile, type ReconcileEnv } from './reconcile';

export interface Env extends PostEnv, StripeApiEnv, ReconcileEnv {
  DB: D1Database;
  STRIPE_WEBHOOK_SECRET?: string;
  ADMIN_TOKEN?: string;
}

/** 承認・投入は誰でも叩けてはいけない。管理トークンを要求する。 */
function isAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (presented.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ env.ADMIN_TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

const ACCOUNT_LABELS: Record<string, string> = {
  accounts_receivable: '未収入金',
  sales: '売上高',
  payment_fees: '支払手数料',
  bank: '普通預金',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET is not configured');
    return json({ error: 'not configured' }, 500);
  }

  // 署名検証はJSON.parseする前の生の文字列に対して行う。
  const rawBody = await request.text();
  const verified = await verifyStripeSignature(
    rawBody,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET
  );
  if (!verified.ok) {
    // 理由はログにも応答にも詳しく出さない（署名の当て推量を助けない）。
    console.warn('stripe signature rejected:', verified.reason);
    return json({ error: 'invalid signature' }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (!event?.id || !event?.type) return json({ error: 'invalid event' }, 400);

  const seen = await env.DB.prepare('SELECT event_id FROM processed_events WHERE event_id = ?')
    .bind(event.id)
    .first();
  // 二重に届いても200を返す。エラーを返すとStripeが再送を続ける。
  if (seen) return json({ received: true, duplicate: true });

  let draft: JournalDraft | null;
  try {
    // 手数料がpayloadに無ければStripe APIへ取りに行く。推測で0円を入れないため。
    draft = await buildJournalFromEvent(event, async (chargeId) => {
      const { fee } = await fetchChargeFee(env, chargeId);
      return fee;
    });
  } catch (e) {
    if (e instanceof StripeApiError) {
      console.error(`stripe api failed for ${event.id}: ${e.message}`);
      await env.DB.prepare(
        'INSERT OR IGNORE INTO failed_events (event_id, event_type, reason) VALUES (?, ?, ?)'
      )
        .bind(event.id, event.type, e.message)
        .run();
      // 一時的な失敗の可能性があるので、Stripeに再送させる。
      return json({ error: e.message }, 500);
    }
    if (e instanceof JournalError) {
      // 仕訳にできないものを、黙って捨てない。人が気づける形で残す。
      console.error(`journal build failed for ${event.id}: ${e.message}`);
      await env.DB.prepare(
        'INSERT OR IGNORE INTO failed_events (event_id, event_type, reason) VALUES (?, ?, ?)'
      )
        .bind(event.id, event.type, e.message)
        .run();
      return json({ received: true, stored: false, reason: e.message });
    }
    throw e;
  }

  const statements = [
    env.DB.prepare('INSERT INTO processed_events (event_id, event_type) VALUES (?, ?)').bind(
      event.id,
      event.type
    ),
  ];
  if (draft) {
    const total = draft.lines
      .filter((l) => l.side === 'debit')
      .reduce((sum, l) => sum + l.amount, 0);
    statements.push(
      env.DB.prepare(
        `INSERT INTO journal_drafts (event_id, event_type, issue_date, memo, lines_json, total_amount)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(event.id, event.type, draft.issueDate, draft.memo, JSON.stringify(draft.lines), total)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (e) {
    // 同時に同じイベントが届いてUNIQUE制約に当たった場合もここへ来る。重複は成功として扱う。
    const recheck = await env.DB.prepare('SELECT event_id FROM processed_events WHERE event_id = ?')
      .bind(event.id)
      .first();
    if (recheck) return json({ received: true, duplicate: true });
    throw e;
  }

  return json({ received: true, stored: draft !== null });
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

function renderLines(linesJson: string): string {
  let lines: { side: string; account: string; amount: number }[];
  try {
    lines = JSON.parse(linesJson);
  } catch {
    return '<span class="warn">仕訳の読み出しに失敗</span>';
  }
  const row = (side: string) =>
    lines
      .filter((l) => l.side === side)
      .map(
        (l) =>
          `${escapeHtml(ACCOUNT_LABELS[l.account] ?? l.account)} ${l.amount.toLocaleString('ja-JP')}`
      )
      .join('<br>');
  return `<td>${row('debit')}</td><td>${row('credit')}</td>`;
}

async function renderReview(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, event_type, issue_date, memo, lines_json, total_amount, status, created_at
     FROM journal_drafts ORDER BY id DESC LIMIT 100`
  ).all<{
    id: number;
    event_type: string;
    issue_date: string;
    memo: string;
    lines_json: string;
    total_amount: number;
    status: string;
    created_at: string;
  }>();

  const { results: failures } = await env.DB.prepare(
    'SELECT event_id, event_type, reason, received_at FROM failed_events ORDER BY rowid DESC LIMIT 20'
  ).all<{ event_id: string; event_type: string; reason: string; received_at: string }>();

  const rows = results
    .map(
      (r) => `<tr>
<td>${r.id}</td>
<td>${escapeHtml(r.issue_date)}</td>
<td>${escapeHtml(r.event_type)}</td>
${renderLines(r.lines_json)}
<td class="num">${r.total_amount.toLocaleString('ja-JP')}</td>
<td>${escapeHtml(r.status)}</td>
</tr>`
    )
    .join('\n');

  const failureRows = failures
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.event_id)}</td><td>${escapeHtml(f.event_type)}</td><td>${escapeHtml(f.reason)}</td></tr>`
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>仕訳案の確認</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0e14; color: #e6e6e6; }
h1 { font-size: 1.2rem; }
h2 { font-size: 1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid #333; text-align: left; vertical-align: top; }
th { color: #9aa; font-weight: normal; }
.num { text-align: right; }
.note { color: #9aa; font-size: 0.85rem; }
.warn { color: #f88; }
</style>
</head>
<body>
<h1>仕訳案の確認</h1>
<p class="note">Stripeのイベントから組み立てた仕訳案。<strong>freeeへはまだ投入しない。</strong>投入は人が承認してから行う（P2で実装）。</p>
<table>
<thead><tr><th>#</th><th>日付</th><th>種別</th><th>借方</th><th>貸方</th><th class="num">金額</th><th>状態</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="7">仕訳案はまだありません</td></tr>'}
</tbody>
</table>

<h2>仕訳にできなかったイベント</h2>
<table>
<thead><tr><th>イベントID</th><th>種別</th><th>理由</th></tr></thead>
<tbody>
${failureRows || '<tr><td colspan="3">ありません</td></tr>'}
</tbody>
</table>
</body>
</html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * 承認された仕訳案をfreeeへ投入する。
 * 投入したIDを記録できて初めて成功とする（記録が無いと取り消せないため）。
 */
async function handlePost(request: Request, env: Env, draftId: number): Promise<Response> {
  const draft = await env.DB.prepare(
    'SELECT id, issue_date, memo, lines_json, status FROM journal_drafts WHERE id = ?'
  )
    .bind(draftId)
    .first<{ id: number; issue_date: string; memo: string; lines_json: string; status: string }>();

  if (!draft) return json({ error: 'not found' }, 404);
  // 二重投入を防ぐ。投入済みのものは何度叩いても投げ直さない。
  if (draft.status === 'posted') return json({ error: 'already posted' }, 409);

  let lines: JournalLine[];
  try {
    lines = JSON.parse(draft.lines_json);
  } catch {
    return json({ error: 'lines_json broken' }, 500);
  }

  try {
    const result = await postJournal(env, {
      issueDate: draft.issue_date,
      lines,
      memo: draft.memo,
    });
    await env.DB.prepare(
      `UPDATE journal_drafts
          SET status = 'posted', freee_manual_journal_id = ?, posted_at = datetime('now')
        WHERE id = ?`
    )
      .bind(result.manualJournalId, draftId)
      .run();
    return json({ posted: true, freee_manual_journal_id: result.manualJournalId });
  } catch (e) {
    if (e instanceof FreeePostError) {
      console.error(`freee post failed for draft ${draftId}: ${e.message}`);
      return json({ error: e.message }, 502);
    }
    throw e;
  }
}


/**
 * 権限の疎通確認。**状態コードだけを返し、トークンもデータ本体も返さない。**
 *
 * freeeは権限の変更を「再認可したときだけ」反映する（リフレッシュでは変わらない）。
 * 設定したつもりで効いていない、が起きやすいので、実際に叩いて確かめる口を用意する。
 */
async function handleFreeeProbe(env: Env): Promise<Response> {
  const companyId = env.FREEE_COMPANY_ID ?? '';
  const token = await getAccessToken(env);

  const targets: { label: string; path: string }[] = [
    { label: '[会計] 事業所', path: `/api/1/companies/${companyId}` },
    { label: '[会計] 勘定科目', path: `/api/1/account_items?company_id=${companyId}&limit=1` },
    { label: '[会計] 税区分', path: `/api/1/taxes/companies/${companyId}` },
    { label: '[会計] 取引先', path: `/api/1/partners?company_id=${companyId}&limit=1` },
    { label: '[会計] 振替伝票', path: `/api/1/manual_journals?company_id=${companyId}&limit=1` },
    { label: '[会計] 仕訳帳', path: `/api/1/journals?company_id=${companyId}&download_type=csv` },
    { label: '[会計] 貸借対照表', path: `/api/1/reports/trial_bs?company_id=${companyId}` },
    { label: '[会計] 損益計算書', path: `/api/1/reports/trial_pl?company_id=${companyId}` },
    // 権限一覧に有るが、プラン制限の有無を確かめたいもの
    { label: '[会計] 固定資産（プラン制限の検証）', path: `/api/1/fixed_assets?company_id=${companyId}&target_date=2026-01-01&limit=1` },
    { label: '[会計] 総勘定元帳（同上）', path: `/api/1/reports/general_ledgers?company_id=${companyId}&start_date=2026-01-01&end_date=2026-12-31&account_item_id=1` },
  ];

  const results = [];
  for (const t of targets) {
    try {
      const res = await fetch(`https://api.freee.co.jp${t.path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      let detail = '';
      if (!res.ok) {
        const body = await res.text();
        // 本体は返さない。原因の切り分けに要る部分だけを短く抜く。
        detail = body.slice(0, 200);
      }
      results.push({ label: t.label, status: res.status, ok: res.ok, detail });
    } catch (e) {
      results.push({ label: t.label, status: 0, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }
  return json({ companyId, results });
}

/**
 * **読み取り専用**のマスタ取得。keiri-erp の `PRE-3`（科目・税区分の実取得）のために足した口。
 *
 * 守っていること:
 * - **事業所IDをリクエストから受け取らない。**必ず `FREEE_COMPANY_ID`（テスト事業所）を使う
 * - `FREEE_BLOCKED_COMPANY_IDS` に入っていたら拒否する（投入側と同じ安全弁）
 * - **GETしか投げない。**freeeへ書き込む経路をこの関数は持たない
 * - **アクセストークンを応答へ含めない**
 * - 帳簿データ（仕訳・取引）は取らない。**マスタだけ**
 */
async function handleFreeeMaster(env: Env): Promise<Response> {
  const companyId = Number(env.FREEE_COMPANY_ID);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return json({ error: 'FREEE_COMPANY_ID が設定されていません' }, 500);
  }
  const blocked = (env.FREEE_BLOCKED_COMPANY_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (blocked.includes(companyId)) {
    return json({ error: `読み取りが禁止されている事業所です: ${companyId}` }, 403);
  }

  const token = await getAccessToken(env);
  const targets: { key: string; path: string }[] = [
    { key: 'account_items', path: `/api/1/account_items?company_id=${companyId}` },
    { key: 'taxes_company', path: `/api/1/taxes/companies/${companyId}` },
    { key: 'tax_codes', path: `/api/1/taxes/codes` },
    { key: 'company', path: `/api/1/companies/${companyId}?details=true` },
  ];

  const out: Record<string, unknown> = { companyId };
  for (const t of targets) {
    const res = await fetch(`https://api.freee.co.jp${t.path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      out[t.key] = { error: true, status: res.status, detail: (await res.text()).slice(0, 200) };
      continue;
    }
    out[t.key] = await res.json();
  }
  return json(out);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/webhook/stripe') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return handleWebhook(request, env);
    }

    // 認可URLの組み立てと、認可コードの受け取り。どちらも管理トークンが要る。
    if (url.pathname === '/admin/freee/authorize-url') {
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      if (!env.FREEE_CLIENT_ID) return json({ error: 'FREEE_CLIENT_ID missing' }, 500);
      return json({ url: buildAuthorizeUrl(env.FREEE_CLIENT_ID) });
    }

    if (url.pathname === '/admin/freee/authorize') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      const body = (await request.json().catch(() => null)) as { code?: string } | null;
      if (!body?.code) return json({ error: 'code required' }, 400);
      try {
        const { expiresAt } = await exchangeAndStore(env, body.code);
        return json({ authorized: true, expires_at: expiresAt });
      } catch (e) {
        if (e instanceof FreeeAuthorizeError) return json({ error: e.message }, 400);
        throw e;
      }
    }

    if (url.pathname === '/admin/freee/probe') {
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleFreeeProbe(env);
    }

    // 読み取り専用。keiri-erp の PRE-3 で使う。GET のみ。
    if (url.pathname === '/admin/freee/master') {
      if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      return handleFreeeMaster(env);
    }

    if (url.pathname === '/admin/reconcile') {
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      const result = await reconcile(env);
      return json(result);
    }

    const postMatch = url.pathname.match(/^\/api\/drafts\/(\d+)\/post$/);
    if (postMatch) {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!isAdmin(request, env)) return json({ error: 'unauthorized' }, 401);
      return handlePost(request, env, Number(postMatch[1]));
    }

    if (url.pathname === '/api/drafts') {
      const { results } = await env.DB.prepare(
        `SELECT id, event_type, issue_date, memo, lines_json, total_amount, status, created_at
         FROM journal_drafts ORDER BY id DESC LIMIT 100`
      ).all();
      return json(results);
    }

    if (url.pathname === '/') return renderReview(env);

    return json({ error: 'not found' }, 404);
  },

  // 毎日の照合。静かなのが正常で、差が出たときだけ通知する。
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const result = await reconcile(env);
          await notifyIfFindings(env, result);
        } catch (e) {
          console.error('照合に失敗:', e instanceof Error ? e.message : String(e));
        }
      })()
    );
  },
};
