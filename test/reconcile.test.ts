import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcile, reconcileWindow, type ReconcileEnv } from '../src/reconcile';

const ACCOUNT_IDS = JSON.stringify({
  accounts_receivable: 1072165672,
  payment_fees: 1072165784,
  sales: 1072165747,
  bank: 1078738479,
});

function baseEnv(): ReconcileEnv {
  return {
    DB: env.DB,
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    FREEE_COMPANY_ID: '12785959',
    FREEE_ACCOUNT_IDS: ACCOUNT_IDS,
  };
}

/** Stripeとfreeeの応答を差し替える。ネットワークへは出さない。 */
function stubApis(opts: {
  stripeCharges: { id: string; amount: number; status: string; fee: number }[];
  freeeJournals: { entry_side: string; account_item_id: number; amount: number }[][];
}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.stripe.com/v1/charges')) {
      return new Response(
        JSON.stringify({
          has_more: false,
          data: opts.stripeCharges.map((c) => ({
            id: c.id,
            amount: c.amount,
            status: c.status,
            balance_transaction: { fee: c.fee },
          })),
        }),
        { status: 200 }
      );
    }
    if (url.includes('api.freee.co.jp/api/1/manual_journals')) {
      return new Response(
        JSON.stringify({ manual_journals: opts.freeeJournals.map((details) => ({ details })) }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function resetTables(): Promise<void> {
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS journal_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, issue_date TEXT NOT NULL, memo TEXT NOT NULL, lines_json TEXT NOT NULL, total_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', freee_manual_journal_id INTEGER, posted_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS failed_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, reason TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS freee_tokens (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL, refreshing_until TEXT)"
  );
  await env.DB.exec('DELETE FROM journal_drafts');
  await env.DB.exec('DELETE FROM failed_events');
  await env.DB.exec('DELETE FROM freee_tokens');
  await env.DB.prepare(
    'INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)'
  )
    .bind('tok', 'ref', new Date(Date.now() + 3600_000).toISOString())
    .run();
}

describe('照合の期間', () => {
  it('JSTで日付を切る（仕訳の計上日と揃える）', () => {
    // 2026-09-08 07:00 JST = 2026-09-07 22:00 UTC
    const w = reconcileWindow(new Date('2026-09-07T22:00:00Z'), 0);
    expect(w.to).toBe('2026-09-08');
  });
});

describe('照合', () => {
  beforeEach(resetTables);

  it('金額が一致していれば何も報告しない（静かなのが正常）', async () => {
    const restore = stubApis({
      stripeCharges: [{ id: 'ch_1', amount: 10000, status: 'succeeded', fee: 360 }],
      freeeJournals: [
        [
          { entry_side: 'debit', account_item_id: 1072165672, amount: 9640 },
          { entry_side: 'debit', account_item_id: 1072165784, amount: 360 },
          { entry_side: 'credit', account_item_id: 1072165747, amount: 10000 },
        ],
      ],
    });
    try {
      const result = await reconcile(baseEnv());
      expect(result.findings).toEqual([]);
      expect(result.stripeSalesTotal).toBe(10000);
      expect(result.freeeSalesTotal).toBe(10000);
    } finally {
      restore();
    }
  });

  // 1件だけ抜けても貸借は合うので、freee側だけを見ても気付けない。
  it('freeeに1件入っていなければ売上の差として検知する', async () => {
    const restore = stubApis({
      stripeCharges: [
        { id: 'ch_1', amount: 10000, status: 'succeeded', fee: 360 },
        { id: 'ch_2', amount: 5000, status: 'succeeded', fee: 180 },
      ],
      freeeJournals: [
        [
          { entry_side: 'debit', account_item_id: 1072165672, amount: 9640 },
          { entry_side: 'debit', account_item_id: 1072165784, amount: 360 },
          { entry_side: 'credit', account_item_id: 1072165747, amount: 10000 },
        ],
      ],
    });
    try {
      const result = await reconcile(baseEnv());
      const sales = result.findings.find((f) => f.label === '売上が一致しない');
      expect(sales).toBeDefined();
      expect(sales?.detail).toContain('5,000');
      expect(result.findings.find((f) => f.label === '支払手数料が一致しない')).toBeDefined();
    } finally {
      restore();
    }
  });

  it('返金は売上から差し引いて突き合わせる', async () => {
    const restore = stubApis({
      stripeCharges: [{ id: 'ch_1', amount: 10000, status: 'succeeded', fee: 360 }],
      freeeJournals: [
        [
          { entry_side: 'debit', account_item_id: 1072165672, amount: 9640 },
          { entry_side: 'debit', account_item_id: 1072165784, amount: 360 },
          { entry_side: 'credit', account_item_id: 1072165747, amount: 10000 },
        ],
        // 返金（売上が借方に立つ）
        [
          { entry_side: 'debit', account_item_id: 1072165747, amount: 10000 },
          { entry_side: 'credit', account_item_id: 1072165672, amount: 10000 },
        ],
      ],
    });
    try {
      const result = await reconcile(baseEnv());
      // freee側の売上は 10,000 - 10,000 = 0 になる
      expect(result.freeeSalesTotal).toBe(0);
      expect(result.findings.find((f) => f.label === '売上が一致しない')).toBeDefined();
    } finally {
      restore();
    }
  });

  // 仕訳にできなかったイベントは、売上がまるごと抜けている可能性がある。
  it('failed_events があれば error として報告する', async () => {
    await env.DB.prepare(
      'INSERT INTO failed_events (event_id, event_type, reason) VALUES (?, ?, ?)'
    )
      .bind('evt_bad', 'charge.succeeded', '手数料が未確定')
      .run();

    const restore = stubApis({ stripeCharges: [], freeeJournals: [] });
    try {
      const result = await reconcile(baseEnv());
      const f = result.findings.find((x) => x.label === '仕訳にできなかったイベント');
      expect(f?.level).toBe('error');
    } finally {
      restore();
    }
  });

  // 承認待ちがあるうちは金額が合わなくて当然なので、金額差では鳴らさない。
  it('未投入の仕訳案があるときは金額差ではなく承認待ちとして報告する', async () => {
    await env.DB.prepare(
      `INSERT INTO journal_drafts (event_id, event_type, issue_date, memo, lines_json, total_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    )
      .bind('evt_p', 'charge.succeeded', '2026-09-08', 'memo', '[]', 5000)
      .run();

    const restore = stubApis({
      stripeCharges: [{ id: 'ch_1', amount: 5000, status: 'succeeded', fee: 180 }],
      freeeJournals: [],
    });
    try {
      const result = await reconcile(baseEnv());
      expect(result.findings.find((f) => f.label === '未投入の仕訳案')?.level).toBe('warn');
      expect(result.findings.find((f) => f.label === '売上が一致しない')).toBeUndefined();
    } finally {
      restore();
    }
  });
});
