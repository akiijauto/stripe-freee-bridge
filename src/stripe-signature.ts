// Stripe Webhookの署名検証。Workers上ではNode版stripe SDKのconstructEventが使えないため、
// Web Crypto APIで同じ検証を実装する。

export type VerifyResult = { ok: true } | { ok: false; reason: string };

const DEFAULT_TOLERANCE_SECONDS = 300;

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

// Stripe-Signature: t=1699999999,v1=abc...,v1=def...
// 鍵のローテーション中は v1 が複数並ぶため、配列で受ける。
function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp = NaN;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }

  if (!Number.isInteger(timestamp) || signatures.length === 0) return null;
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 先頭何文字が一致したかで処理時間が変わらないようにする（早期returnしない）。
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 署名を検証する。rawBodyはJSON.parseする前の文字列でなければならない
 * （パースして組み直すとキーの順序や空白が変わり、署名が一致しなくなる）。
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  options: { toleranceSeconds?: number; nowSeconds?: number } = {}
): Promise<VerifyResult> {
  if (!signatureHeader) return { ok: false, reason: 'signature header missing' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'signature header malformed' };

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  // 古い正規のリクエストをそのまま再送されるのを防ぐ（リプレイ攻撃対策）。
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  const matched = parsed.signatures.some((candidate) => timingSafeEqual(candidate, expected));

  return matched ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}
