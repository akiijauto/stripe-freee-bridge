import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FreeePostError, postJournal, resolveAccountMap } from '../src/freee-post';
import { getAccessToken } from '../src/freee-token';
import type { JournalLine } from '../src/journal';

const ACCOUNT_IDS = JSON.stringify({
  accounts_receivable: 1072165672,
  payment_fees: 1072165784,
  sales: 1072165747,
  bank: 9999999,
});

const LINES: JournalLine[] = [
  { side: 'debit', account: 'accounts_receivable', amount: 964 },
  { side: 'debit', account: 'payment_fees', amount: 36 },
  { side: 'credit', account: 'sales', amount: 1000 },
];

async function resetTokens(): Promise<void> {
  await env.DB.exec(
    'CREATE TABLE IF NOT EXISTS freee_tokens (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL, refreshing_until TEXT)'
  );
  await env.DB.exec('DELETE FROM freee_tokens');
}

describe('科目の対応づけ', () => {
  it('設定が無ければ投入させない', () => {
    expect(() => resolveAccountMap({ DB: env.DB })).toThrow(/FREEE_ACCOUNT_IDS/);
  });

  it('JSONとして読めなければ拒む', () => {
    expect(() => resolveAccountMap({ DB: env.DB, FREEE_ACCOUNT_IDS: 'not json' })).toThrow(
      /JSONとして読めません/
    );
  });

  it('科目IDが数値でなければ拒む', () => {
    expect(() =>
      resolveAccountMap({ DB: env.DB, FREEE_ACCOUNT_IDS: '{"sales":"abc"}' })
    ).toThrow(/科目IDが不正/);
  });
});

describe('投入の安全弁', () => {
  // 設定ミスで本番の帳簿を汚さないよう、コード側でも止める。
  it('禁止指定された事業所への投入を拒む', async () => {
    await expect(
      postJournal(
        {
          DB: env.DB,
          FREEE_COMPANY_ID: '999999',
          FREEE_ACCOUNT_IDS: ACCOUNT_IDS,
          FREEE_BLOCKED_COMPANY_IDS: '999999',
        },
        { issueDate: '2026-09-08', lines: LINES, memo: 'test' }
      )
    ).rejects.toThrow(/投入が禁止されている事業所/);
  });

  it('禁止リストが複数でも効く', async () => {
    await expect(
      postJournal(
        {
          DB: env.DB,
          FREEE_COMPANY_ID: '222222',
          FREEE_ACCOUNT_IDS: ACCOUNT_IDS,
          FREEE_BLOCKED_COMPANY_IDS: '111111, 222222 ,333333',
        },
        { issueDate: '2026-09-08', lines: LINES, memo: 'test' }
      )
    ).rejects.toThrow(/投入が禁止されている事業所/);
  });

  it('company_idが無ければ投入しない', async () => {
    await expect(
      postJournal(
        { DB: env.DB, FREEE_ACCOUNT_IDS: ACCOUNT_IDS },
        { issueDate: '2026-09-08', lines: LINES, memo: 'test' }
      )
    ).rejects.toThrow(/FREEE_COMPANY_ID/);
  });

  it('対応づけの無い科目があれば投入しない', async () => {
    await expect(
      postJournal(
        {
          DB: env.DB,
          FREEE_COMPANY_ID: '12785959',
          FREEE_ACCOUNT_IDS: '{"sales":1072165747}',
        },
        { issueDate: '2026-09-08', lines: LINES, memo: 'test' }
      )
    ).rejects.toThrow(/科目の対応づけがありません/);
  });
});

describe('摘要', () => {
  // 摘要が無いと、freeeの画面を見てもどのStripe決済の仕訳か追えない。
  it('全明細に摘要を載せてfreeeへ送る', async () => {
    const sent: { body: string } = { body: '' };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/1/manual_journals')) {
        sent.body = String(init?.body ?? '');
        return new Response(JSON.stringify({ manual_journal: { id: 12345 } }), { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      const future = new Date(Date.now() + 3600_000).toISOString();
      await env.DB.exec(
        'CREATE TABLE IF NOT EXISTS freee_tokens (id INTEGER PRIMARY KEY CHECK (id = 1), access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at TEXT NOT NULL, refreshing_until TEXT)'
      );
      await env.DB.exec('DELETE FROM freee_tokens');
      await env.DB.prepare(
        'INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)'
      )
        .bind('tok', 'ref', future)
        .run();

      await postJournal(
        { DB: env.DB, FREEE_COMPANY_ID: '12785959', FREEE_ACCOUNT_IDS: ACCOUNT_IDS },
        { issueDate: '2026-09-08', lines: LINES, memo: 'Stripe売上 ch_abc123' }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const payload = JSON.parse(sent.body);
    expect(payload.details).toHaveLength(3);
    for (const d of payload.details) {
      expect(d.description).toBe('Stripe売上 ch_abc123');
    }
  });
});

describe('トークンの取り回し', () => {
  beforeEach(resetTokens);

  it('未認可なら分かる形で止まる', async () => {
    await expect(getAccessToken({ DB: env.DB })).rejects.toThrow(/初回の認可がまだ/);
  });

  it('期限内のトークンはそのまま返す（更新しない）', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    await env.DB.prepare(
      'INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at) VALUES (1, ?, ?, ?)'
    )
      .bind('access_live', 'refresh_live', future)
      .run();

    expect(await getAccessToken({ DB: env.DB })).toBe('access_live');
  });

  // 別の実行が更新中なら、こちらは更新しにいかない。
  // 2つが同時に更新すると、片方のリフレッシュトークンが死ぬため。
  it('ロック中は更新せず、期限切れのまま待たせる', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const leaseAlive = new Date(Date.now() + 20_000).toISOString();
    await env.DB.prepare(
      'INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at, refreshing_until) VALUES (1, ?, ?, ?, ?)'
    )
      .bind('access_old', 'refresh_old', past, leaseAlive)
      .run();

    await expect(getAccessToken({ DB: env.DB })).rejects.toThrow(/更新中/);

    // 待たされた側がリフレッシュトークンを書き換えていないこと。
    const row = await env.DB.prepare('SELECT refresh_token FROM freee_tokens WHERE id = 1').first<{
      refresh_token: string;
    }>();
    expect(row?.refresh_token).toBe('refresh_old');
  });

  // 更新中に落ちても永久ロックにならないことを確かめる。
  it('期限切れのリースは無視して更新へ進む', async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const leaseExpired = new Date(Date.now() - 60_000).toISOString();
    await env.DB.prepare(
      'INSERT INTO freee_tokens (id, access_token, refresh_token, expires_at, refreshing_until) VALUES (1, ?, ?, ?, ?)'
    )
      .bind('access_old', 'refresh_old', past, leaseExpired)
      .run();

    // client_idが無いのでリフレッシュ自体は失敗するが、
    // 「更新中」ではなく「設定が無い」で止まる＝ロックは取れている。
    await expect(getAccessToken({ DB: env.DB })).rejects.toThrow(/FREEE_CLIENT_ID/);

    // 失敗したらロックを解放して次の実行が試せること。
    const row = await env.DB.prepare('SELECT refreshing_until FROM freee_tokens WHERE id = 1').first<{
      refreshing_until: string | null;
    }>();
    expect(row?.refreshing_until).toBeNull();
  });
});
