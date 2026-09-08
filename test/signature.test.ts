import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../src/stripe-signature';

const SECRET = 'whsec_test_secret';
const BODY = '{"id":"evt_1","type":"charge.succeeded"}';
const NOW = 1757308800;

async function sign(body: string, timestamp: number, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${timestamp},v1=${hex}`;
}

describe('Stripe署名の検証', () => {
  it('正しい署名を通す', async () => {
    const header = await sign(BODY, NOW);
    expect(await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: NOW })).toEqual({
      ok: true,
    });
  });

  it('鍵が違えば弾く', async () => {
    const header = await sign(BODY, NOW, 'whsec_other');
    const result = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: NOW });
    expect(result.ok).toBe(false);
  });

  it('本文が1文字でも変わっていれば弾く', async () => {
    const header = await sign(BODY, NOW);
    const tampered = BODY.replace('charge.succeeded', 'charge.refunded');
    const result = await verifyStripeSignature(tampered, header, SECRET, { nowSeconds: NOW });
    expect(result.ok).toBe(false);
  });

  // 正規のリクエストをそのまま後で再送されても通さない。
  it('許容差を超えて古い署名を弾く', async () => {
    const header = await sign(BODY, NOW - 3600);
    const result = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('未来へ大きくずれた署名も弾く', async () => {
    const header = await sign(BODY, NOW + 3600);
    const result = await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: 'timestamp outside tolerance' });
  });

  it('ヘッダが無ければ弾く', async () => {
    const result = await verifyStripeSignature(BODY, null, SECRET, { nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: 'signature header missing' });
  });

  it('壊れたヘッダを弾く', async () => {
    const result = await verifyStripeSignature(BODY, 'garbage', SECRET, { nowSeconds: NOW });
    expect(result).toEqual({ ok: false, reason: 'signature header malformed' });
  });

  // 鍵のローテーション中はv1が複数並ぶ。どれか1つ合えば通す。
  it('v1が複数あるとき、1つでも合えば通す', async () => {
    const valid = await sign(BODY, NOW);
    const header = `${valid},v1=${'0'.repeat(64)}`;
    expect(await verifyStripeSignature(BODY, header, SECRET, { nowSeconds: NOW })).toEqual({
      ok: true,
    });
  });
});
