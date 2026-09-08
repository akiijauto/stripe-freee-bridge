// Stripe APIから手数料を取りに行く。
//
// なぜ要るのか: Webhookのpayloadでは `balance_transaction` が**文字列ID**で届き、
// 手数料が入っていない。0円と推測すると手数料が費用に立たず、
// 売上だけが総額で計上される。貸借は合うので**検算をすり抜ける。**
// そのため、取りに行って確かめる。

const CHARGES_URL = 'https://api.stripe.com/v1/charges';

export class StripeApiError extends Error {}

/** 手数料がまだ確定していない（残高取引が未作成）。あとで再送されれば取れる。 */
export class FeeNotReadyError extends StripeApiError {}

export interface StripeApiEnv {
  STRIPE_SECRET_KEY?: string;
}

/**
 * chargeを取り直して手数料を得る。
 *
 * **Webhookのpayloadでは `balance_transaction` が `null` のことがある。**
 * 決済の成立と残高取引の作成にタイムラグがあるため（2026-09-08に実測）。
 * IDだけが入っている場合もあるので、`expand` で実体ごと取る。
 */
export async function fetchChargeFee(
  env: StripeApiEnv,
  chargeId: string
): Promise<{ fee: number; currency: string }> {
  if (!env.STRIPE_SECRET_KEY) {
    throw new StripeApiError('STRIPE_SECRET_KEY が設定されていません');
  }

  const url = `${CHARGES_URL}/${encodeURIComponent(chargeId)}?expand[]=balance_transaction`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });

  if (!res.ok) {
    // 応答本文にキーは載らないが、余計なものを残さないようステータスだけ出す。
    throw new StripeApiError(`charge の取得に失敗: HTTP ${res.status}`);
  }

  const payload = (await res.json()) as {
    balance_transaction?: { fee?: number; currency?: string } | string | null;
  };
  const bt = payload.balance_transaction;

  if (bt === null || bt === undefined) {
    // まだ残高取引が作られていない。0円と推測せず、再送を待つ。
    throw new FeeNotReadyError('残高取引がまだ作られていない。手数料は未確定');
  }
  if (typeof bt === 'string') {
    throw new StripeApiError('balance_transaction が展開されなかった');
  }
  if (typeof bt.fee !== 'number' || typeof bt.currency !== 'string') {
    throw new StripeApiError('balance_transaction に fee / currency が無い');
  }
  return { fee: bt.fee, currency: bt.currency };
}
