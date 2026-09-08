import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

const SECRET = 'whsec_test_secret';

async function signedHeaders(body: string): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { 'stripe-signature': `t=${timestamp},v1=${hex}`, 'content-type': 'application/json' };
}

function chargeEvent(id: string): string {
  return JSON.stringify({
    id,
    type: 'charge.succeeded',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'ch_1', amount: 1000, currency: 'jpy', balance_transaction: { fee: 36 } } },
  });
}

async function post(body: string): Promise<Response> {
  return SELF.fetch('https://example.com/webhook/stripe', {
    method: 'POST',
    headers: await signedHeaders(body),
    body,
  });
}

describe('Webhookの受け口', () => {
  beforeEach(async () => {
    // D1のexec()は文をNEWLINEで区切るため、CREATE TABLE文は1行に詰める。
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS processed_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS journal_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, event_type TEXT NOT NULL, issue_date TEXT NOT NULL, memo TEXT NOT NULL, lines_json TEXT NOT NULL, total_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', freee_manual_journal_id INTEGER, posted_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS failed_events (event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL, reason TEXT NOT NULL, received_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    await env.DB.exec('DELETE FROM journal_drafts');
    await env.DB.exec('DELETE FROM processed_events');
    await env.DB.exec('DELETE FROM failed_events');
  });

  it('署名の無いリクエストを400で拒む', async () => {
    const res = await SELF.fetch('https://example.com/webhook/stripe', {
      method: 'POST',
      body: chargeEvent('evt_nosig'),
    });
    expect(res.status).toBe(400);
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM journal_drafts').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('正しい署名なら仕訳案を保存する', async () => {
    const res = await post(chargeEvent('evt_ok'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, stored: true });

    const draft = await env.DB.prepare('SELECT event_id, total_amount FROM journal_drafts').first<{
      event_id: string;
      total_amount: number;
    }>();
    expect(draft?.event_id).toBe('evt_ok');
    expect(draft?.total_amount).toBe(1000);
  });

  // Stripeはat-least-once配信なので、同じイベントが2回届く。
  it('同じイベントを2回受けても二重計上しない', async () => {
    const body = chargeEvent('evt_dup');
    await post(body);
    const second = await post(body);

    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });

    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM journal_drafts').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('対応しないイベントは記録するが仕訳案は作らない', async () => {
    const body = JSON.stringify({
      id: 'evt_ignored',
      type: 'customer.created',
      created: Math.floor(Date.now() / 1000),
      data: { object: {} },
    });
    const res = await post(body);
    expect(await res.json()).toEqual({ received: true, stored: false });

    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM journal_drafts').first<{ n: number }>();
    expect(count?.n).toBe(0);
    const seen = await env.DB.prepare('SELECT COUNT(*) as n FROM processed_events').first<{ n: number }>();
    expect(seen?.n).toBe(1);
  });

  // 実測: 決済直後は残高取引がまだ作られておらず、chargeを取り直しても手数料が確定しない。
  // 0円と推測せず500を返してStripeに再送させる。黙って捨てない。
  it('手数料が未確定なら500で再送させ、仕訳案を作らない', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('api.stripe.com/v1/charges')) {
        // 残高取引がまだ無い状態を模す
        return new Response(JSON.stringify({ id: 'ch_2', balance_transaction: null }), {
          status: 200,
        });
      }
      return originalFetch(input as RequestInfo, init);
    }) as typeof fetch;

    try {
      const body = JSON.stringify({
        id: 'evt_badfee',
        type: 'charge.succeeded',
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'ch_2', amount: 1000, currency: 'jpy', balance_transaction: null } },
      });
      const res = await post(body);
      expect(res.status).toBe(500);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const failed = await env.DB.prepare('SELECT event_id, reason FROM failed_events').first<{
      event_id: string;
      reason: string;
    }>();
    expect(failed?.event_id).toBe('evt_badfee');
    expect(failed?.reason).toMatch(/残高取引がまだ/);

    // 仕訳案は作られていないこと（0円で通していない）。
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM journal_drafts').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('GETは405で拒む', async () => {
    const res = await SELF.fetch('https://example.com/webhook/stripe');
    expect(res.status).toBe(405);
  });

  it('確認画面が引ける', async () => {
    await post(chargeEvent('evt_ui'));
    const res = await SELF.fetch('https://example.com/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('仕訳案の確認');
    expect(html).toContain('未収入金');
  });
});
