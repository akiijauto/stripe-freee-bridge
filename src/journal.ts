// Stripeのイベントから仕訳案を組み立てる。
//
// ここではfreeeの勘定科目IDを持たない。科目は抽象キーで表し、freeeのIDへの対応づけは
// 投入側（P2）が設定として持つ。移行案件で「変換ではなく科目の対応づけが本体だった」と
// 分かっているため、対応表は人が見える1か所に集める。

export type AccountKey =
  | 'accounts_receivable' // 未収入金（Stripe残高）
  | 'sales' // 売上高
  | 'payment_fees' // 支払手数料
  | 'bank'; // 普通預金

export interface JournalLine {
  side: 'debit' | 'credit';
  account: AccountKey;
  amount: number;
}

export interface JournalDraft {
  issueDate: string; // YYYY-MM-DD
  memo: string;
  lines: JournalLine[];
}

export class JournalError extends Error {}

// 円は最小単位が1円（zero-decimal currency）なので、Stripeの amount をそのまま円として扱える。
// ドル等は最小単位がセントなので同じ扱いにすると100倍ずれる。対応通貨を明示的に絞る。
const ZERO_DECIMAL_CURRENCIES = new Set(['jpy']);

export function toYen(amount: number, currency: string): number {
  const normalized = currency.toLowerCase();
  if (!ZERO_DECIMAL_CURRENCIES.has(normalized)) {
    throw new JournalError(`unsupported currency: ${currency}`);
  }
  if (!Number.isInteger(amount)) {
    throw new JournalError(`amount must be an integer: ${amount}`);
  }
  return amount;
}

// 日本の帳簿なので、計上日はJST(UTC+9)で決める。UTCのまま日付を切ると
// 日本時間の朝9時前の取引が前日付になり、期末（12/31）をまたぐと事業年度がずれる。
const JST_OFFSET_SECONDS = 9 * 60 * 60;

export function unixToDate(seconds: number): string {
  return new Date((seconds + JST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** 貸借が一致しているか、金額が正の整数かを確かめる。合わなければ保存させない。 */
export function assertBalanced(draft: JournalDraft): void {
  if (draft.lines.length === 0) throw new JournalError('journal has no lines');

  let debit = 0;
  let credit = 0;
  for (const line of draft.lines) {
    if (!Number.isInteger(line.amount) || line.amount <= 0) {
      throw new JournalError(`line amount must be a positive integer: ${line.amount}`);
    }
    if (line.side === 'debit') debit += line.amount;
    else credit += line.amount;
  }

  if (debit !== credit) {
    throw new JournalError(`journal not balanced: debit=${debit} credit=${credit}`);
  }
}

/**
 * 売上計上。Stripeの入金は手数料が差し引かれた額で届くので、
 * 売上は総額で立て、手数料は費用として別に立てる。
 *
 *   借方 未収入金 (gross - fee) / 貸方 売上高 gross
 *   借方 支払手数料 fee
 */
export function buildSalesJournal(params: {
  gross: number;
  fee: number;
  issueDate: string;
  memo: string;
}): JournalDraft {
  const { gross, fee, issueDate, memo } = params;

  if (!Number.isInteger(gross) || gross <= 0) {
    throw new JournalError(`gross must be a positive integer: ${gross}`);
  }
  if (!Number.isInteger(fee) || fee < 0) {
    throw new JournalError(`fee must be a non-negative integer: ${fee}`);
  }
  if (fee >= gross) {
    throw new JournalError(`fee must be smaller than gross: gross=${gross} fee=${fee}`);
  }

  const lines: JournalLine[] = [
    { side: 'debit', account: 'accounts_receivable', amount: gross - fee },
  ];
  // 手数料0円の決済（無料キャンペーン等）で金額0の行を作らない。
  if (fee > 0) lines.push({ side: 'debit', account: 'payment_fees', amount: fee });
  lines.push({ side: 'credit', account: 'sales', amount: gross });

  const draft: JournalDraft = { issueDate, memo, lines };
  assertBalanced(draft);
  return draft;
}

/**
 * 入金消込。Stripe残高から銀行へ振り込まれた時点で、未収入金を落とす。
 *
 *   借方 普通預金 amount / 貸方 未収入金 amount
 */
export function buildPayoutJournal(params: {
  amount: number;
  issueDate: string;
  memo: string;
}): JournalDraft {
  const { amount, issueDate, memo } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new JournalError(`amount must be a positive integer: ${amount}`);
  }

  const draft: JournalDraft = {
    issueDate,
    memo,
    lines: [
      { side: 'debit', account: 'bank', amount },
      { side: 'credit', account: 'accounts_receivable', amount },
    ],
  };
  assertBalanced(draft);
  return draft;
}

/**
 * 返金。Stripeは返金しても決済手数料を返さないため、支払手数料は戻さない。
 *
 *   借方 売上高 amount / 貸方 未収入金 amount
 */
export function buildRefundJournal(params: {
  amount: number;
  issueDate: string;
  memo: string;
}): JournalDraft {
  const { amount, issueDate, memo } = params;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new JournalError(`amount must be a positive integer: ${amount}`);
  }

  const draft: JournalDraft = {
    issueDate,
    memo,
    lines: [
      { side: 'debit', account: 'sales', amount },
      { side: 'credit', account: 'accounts_receivable', amount },
    ],
  };
  assertBalanced(draft);
  return draft;
}

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/**
 * イベントから手数料の取り出し方を決める。
 *
 * **推測で0円を入れない**（0を入れると手数料が費用に立たず、売上だけ総額で計上されて、
 * 貸借は合うので静かにずれる）。
 *
 * 実測（2026-09-08）: Webhookのpayloadでは `balance_transaction` が **null** のことがある。
 * 決済の成立と残高取引の作成にタイムラグがあるため。文字列IDで届くこともある。
 * どちらの場合も、呼び出し側にStripe APIでchargeを取り直させる。
 */
export function feeSourceFromCharge(
  object: Record<string, unknown>
): { kind: 'known'; fee: number } | { kind: 'lookup'; chargeId: string } {
  const balanceTransaction = object.balance_transaction;

  if (typeof balanceTransaction === 'object' && balanceTransaction !== null) {
    const fee = Number((balanceTransaction as Record<string, unknown>).fee);
    if (!Number.isInteger(fee)) {
      throw new JournalError('balance_transaction に fee が無い');
    }
    return { kind: 'known', fee };
  }

  const chargeId = object.id;
  if (typeof chargeId !== 'string' || !chargeId) {
    throw new JournalError('charge に id が無い');
  }
  return { kind: 'lookup', chargeId };
}

/**
 * 対応するイベントなら仕訳案を返し、対応しないイベントは null を返す（無視する）。
 *
 * `charge.succeeded` の手数料は、payloadに入っていなければ `resolveFee` で取りに行く。
 */
export async function buildJournalFromEvent(
  event: StripeEvent,
  resolveFee?: (chargeId: string) => Promise<number>
): Promise<JournalDraft | null> {
  const object = event.data.object;

  switch (event.type) {
    case 'charge.succeeded': {
      const gross = toYen(Number(object.amount), String(object.currency));
      const source = feeSourceFromCharge(object);

      let fee: number;
      if (source.kind === 'known') {
        fee = toYen(source.fee, String(object.currency));
      } else {
        if (!resolveFee) {
          throw new JournalError(
            'balance_transaction is not expanded; fee is unknown (do not assume zero)'
          );
        }
        fee = toYen(await resolveFee(source.chargeId), String(object.currency));
      }

      return buildSalesJournal({
        gross,
        fee,
        issueDate: unixToDate(event.created),
        memo: `Stripe売上 ${String(object.id)}`,
      });
    }

    case 'charge.refunded': {
      const refunded = toYen(Number(object.amount_refunded), String(object.currency));
      return buildRefundJournal({
        amount: refunded,
        issueDate: unixToDate(event.created),
        memo: `Stripe返金 ${String(object.id)}`,
      });
    }

    case 'payout.paid': {
      const amount = toYen(Number(object.amount), String(object.currency));
      return buildPayoutJournal({
        amount,
        issueDate: unixToDate(event.created),
        memo: `Stripe入金 ${String(object.id)}`,
      });
    }

    default:
      return null;
  }
}
