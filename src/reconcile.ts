// StripeとfreeeがほんとうにつながっているかをCronで毎日確かめる。
//
// なぜ要るのか: 仕組みが「止まった」ことには気付けても、「1件だけ抜けた」ことには気付けない。
// Stripeの再送には回数の限りがあり、諦められた時点で売上が1件抜けたまま誰も気付かなくなる。
//
// **本丸は未収入金の残高が合うこと。**売上・入金・返金がすべて正しく連動していれば、
// freeeの未収入金残高はStripeの未入金残高と一致する。1つでも漏れれば必ずここに差が出る。

import { getAccessToken, type TokenEnv } from './freee-token';
import type { PostEnv } from './freee-post';
import type { StripeApiEnv } from './stripe-api';

export interface ReconcileEnv extends TokenEnv, PostEnv, StripeApiEnv {
  DB: D1Database;
  DISCORD_WEBHOOK_URL?: string;
}

export interface Finding {
  level: 'error' | 'warn';
  label: string;
  detail: string;
}

export interface ReconcileResult {
  checkedAt: string;
  windowFrom: string;
  windowTo: string;
  findings: Finding[];
  stripeSalesTotal: number;
  stripeFeeTotal: number;
  freeeSalesTotal: number;
  freeeFeeTotal: number;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function jstDate(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 直近N日をJSTで見る。日付の切り方は仕訳の計上日と揃える。 */
export function reconcileWindow(now: Date, days: number): { from: string; to: string } {
  return {
    from: jstDate(new Date(now.getTime() - days * 24 * 60 * 60 * 1000)),
    to: jstDate(now),
  };
}

async function stripeTotals(
  env: ReconcileEnv,
  fromUnix: number
): Promise<{ sales: number; fee: number; count: number }> {
  if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY が設定されていません');

  let sales = 0;
  let fee = 0;
  let count = 0;
  let startingAfter: string | undefined;

  // 期間内のchargeを全件見る。ページングを打ち切ると「見たつもり」になるので最後まで回す。
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({
      limit: '100',
      'created[gte]': String(fromUnix),
      'expand[]': 'data.balance_transaction',
    });
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetch(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) throw new Error(`Stripeのcharge取得に失敗: HTTP ${res.status}`);

    const payload = (await res.json()) as {
      data: { id: string; amount: number; status: string; balance_transaction?: { fee?: number } | null }[];
      has_more: boolean;
    };

    for (const charge of payload.data) {
      if (charge.status !== 'succeeded') continue;
      count += 1;
      sales += charge.amount;
      fee += charge.balance_transaction?.fee ?? 0;
    }

    if (!payload.has_more || payload.data.length === 0) break;
    startingAfter = payload.data[payload.data.length - 1].id;
  }

  return { sales, fee, count };
}

async function freeeTotals(
  env: ReconcileEnv,
  from: string,
  to: string
): Promise<{ sales: number; fee: number }> {
  const token = await getAccessToken(env);
  const accountIds = JSON.parse(env.FREEE_ACCOUNT_IDS ?? '{}') as Record<string, number>;

  const params = new URLSearchParams({
    company_id: String(env.FREEE_COMPANY_ID ?? ''),
    start_issue_date: from,
    end_issue_date: to,
    limit: '100',
  });

  const res = await fetch(`https://api.freee.co.jp/api/1/manual_journals?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`freeeの振替伝票取得に失敗: HTTP ${res.status}`);

  const payload = (await res.json()) as {
    manual_journals: { details: { entry_side: string; account_item_id: number; amount: number }[] }[];
  };

  let sales = 0;
  let fee = 0;
  for (const journal of payload.manual_journals) {
    for (const d of journal.details) {
      // 売上は貸方が増加、返金で借方に立つので差し引く。
      if (d.account_item_id === accountIds.sales) {
        sales += d.entry_side === 'credit' ? d.amount : -d.amount;
      }
      if (d.account_item_id === accountIds.payment_fees) {
        fee += d.entry_side === 'debit' ? d.amount : -d.amount;
      }
    }
  }
  return { sales, fee };
}

/** 照合する。差や取りこぼしがあれば findings に積む。 */
export async function reconcile(env: ReconcileEnv, now = new Date(), days = 31): Promise<ReconcileResult> {
  const { from, to } = reconcileWindow(now, days);
  const fromUnix = Math.floor(now.getTime() / 1000) - days * 24 * 60 * 60;
  const findings: Finding[] = [];

  const stripe = await stripeTotals(env, fromUnix);
  const freee = await freeeTotals(env, from, to);

  // 投入済みのものだけがfreeeに入っている。まだ承認していないものは差として出るのが正しい。
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM journal_drafts WHERE status = 'pending'"
  ).first<{ n: number }>();
  const failed = await env.DB.prepare('SELECT COUNT(*) as n FROM failed_events').first<{ n: number }>();

  if ((failed?.n ?? 0) > 0) {
    findings.push({
      level: 'error',
      label: '仕訳にできなかったイベント',
      detail: `${failed?.n}件。売上が抜けている可能性がある`,
    });
  }
  if ((pending?.n ?? 0) > 0) {
    findings.push({
      level: 'warn',
      label: '未投入の仕訳案',
      detail: `${pending?.n}件が承認待ちのまま`,
    });
  }

  const salesDiff = stripe.sales - freee.sales;
  const feeDiff = stripe.fee - freee.fee;

  // 未投入ぶんは差が出て当然なので、承認待ちが無いときだけ金額差を異常として扱う。
  if ((pending?.n ?? 0) === 0) {
    if (salesDiff !== 0) {
      findings.push({
        level: 'error',
        label: '売上が一致しない',
        detail: `Stripe ${stripe.sales.toLocaleString('ja-JP')}円 / freee ${freee.sales.toLocaleString('ja-JP')}円（差 ${salesDiff.toLocaleString('ja-JP')}円）`,
      });
    }
    if (feeDiff !== 0) {
      findings.push({
        level: 'error',
        label: '支払手数料が一致しない',
        detail: `Stripe ${stripe.fee.toLocaleString('ja-JP')}円 / freee ${freee.fee.toLocaleString('ja-JP')}円（差 ${feeDiff.toLocaleString('ja-JP')}円）`,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    windowFrom: from,
    windowTo: to,
    findings,
    stripeSalesTotal: stripe.sales,
    stripeFeeTotal: stripe.fee,
    freeeSalesTotal: freee.sales,
    freeeFeeTotal: freee.fee,
  };
}

/** 差があるときだけ通知する。静かなのが正常。 */
export async function notifyIfFindings(env: ReconcileEnv, result: ReconcileResult): Promise<void> {
  if (result.findings.length === 0) return;
  if (!env.DISCORD_WEBHOOK_URL) {
    console.error('照合で差が出たが DISCORD_WEBHOOK_URL が未設定のため通知できない');
    return;
  }

  const lines = result.findings.map(
    (f) => `${f.level === 'error' ? '🔴' : '⚠️'} **${f.label}**: ${f.detail}`
  );
  const content = [
    '**Stripe↔freee 照合で差が出ました**',
    `期間: ${result.windowFrom} 〜 ${result.windowTo}`,
    ...lines,
    'https://stripe-freee-bridge.akiij-auto.workers.dev/',
  ].join('\n');

  try {
    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (res.status >= 400) console.error(`Discord通知に失敗: HTTP ${res.status}`);
  } catch (e) {
    // Webhook URLをログへ出さない。
    console.error('Discord通知に失敗:', e instanceof Error ? e.message : String(e));
  }
}
