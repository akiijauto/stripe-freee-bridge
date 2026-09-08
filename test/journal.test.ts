import { describe, expect, it } from 'vitest';
import {
  JournalError,
  assertBalanced,
  buildJournalFromEvent,
  buildPayoutJournal,
  buildRefundJournal,
  buildSalesJournal,
  toYen,
  unixToDate,
} from '../src/journal';

describe('売上の仕訳', () => {
  it('手数料を売上総額から分けて立てる', () => {
    const draft = buildSalesJournal({ gross: 1000, fee: 36, issueDate: '2026-09-08', memo: 'test' });
    expect(draft.lines).toEqual([
      { side: 'debit', account: 'accounts_receivable', amount: 964 },
      { side: 'debit', account: 'payment_fees', amount: 36 },
      { side: 'credit', account: 'sales', amount: 1000 },
    ]);
  });

  it('手数料0円のときは金額0の行を作らない', () => {
    const draft = buildSalesJournal({ gross: 1000, fee: 0, issueDate: '2026-09-08', memo: 'test' });
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines.some((l) => l.account === 'payment_fees')).toBe(false);
  });

  it('手数料が売上以上なら組み立てを拒む', () => {
    expect(() =>
      buildSalesJournal({ gross: 100, fee: 100, issueDate: '2026-09-08', memo: 'test' })
    ).toThrow(JournalError);
  });

  it('売上が0以下なら組み立てを拒む', () => {
    expect(() =>
      buildSalesJournal({ gross: 0, fee: 0, issueDate: '2026-09-08', memo: 'test' })
    ).toThrow(JournalError);
  });
});

describe('入金と返金の仕訳', () => {
  it('入金は普通預金へ振り替えて未収入金を落とす', () => {
    const draft = buildPayoutJournal({ amount: 964, issueDate: '2026-09-10', memo: 'test' });
    expect(draft.lines).toEqual([
      { side: 'debit', account: 'bank', amount: 964 },
      { side: 'credit', account: 'accounts_receivable', amount: 964 },
    ]);
  });

  it('返金は売上を借方に立てる（手数料は戻さない）', () => {
    const draft = buildRefundJournal({ amount: 1000, issueDate: '2026-09-11', memo: 'test' });
    expect(draft.lines).toEqual([
      { side: 'debit', account: 'sales', amount: 1000 },
      { side: 'credit', account: 'accounts_receivable', amount: 1000 },
    ]);
    expect(draft.lines.some((l) => l.account === 'payment_fees')).toBe(false);
  });
});

describe('貸借の検算', () => {
  it('貸借が合わない仕訳を通さない', () => {
    expect(() =>
      assertBalanced({
        issueDate: '2026-09-08',
        memo: 'broken',
        lines: [
          { side: 'debit', account: 'bank', amount: 100 },
          { side: 'credit', account: 'sales', amount: 90 },
        ],
      })
    ).toThrow(/not balanced/);
  });

  it('行が空の仕訳を通さない', () => {
    expect(() => assertBalanced({ issueDate: '2026-09-08', memo: 'empty', lines: [] })).toThrow(
      JournalError
    );
  });

  it('小数や負数の金額を通さない', () => {
    expect(() =>
      assertBalanced({
        issueDate: '2026-09-08',
        memo: 'fraction',
        lines: [
          { side: 'debit', account: 'bank', amount: 10.5 },
          { side: 'credit', account: 'sales', amount: 10.5 },
        ],
      })
    ).toThrow(JournalError);
  });
});

describe('通貨の扱い', () => {
  it('円はそのまま円として扱う', () => {
    expect(toYen(1000, 'jpy')).toBe(1000);
    expect(toYen(1000, 'JPY')).toBe(1000);
  });

  // ドルは最小単位がセントなので、同じ扱いにすると100倍ずれる。黙って通さない。
  it('円以外は拒む', () => {
    expect(() => toYen(1000, 'usd')).toThrow(/unsupported currency/);
  });
});

describe('イベントからの組み立て', () => {
  const chargeEvent = {
    id: 'evt_1',
    type: 'charge.succeeded',
    created: 1788840000, // 2026-09-08T04:00:00Z
    data: {
      object: {
        id: 'ch_1',
        amount: 1000,
        currency: 'jpy',
        balance_transaction: { fee: 36 },
      },
    },
  };

  it('charge.succeeded から売上の仕訳を作る', async () => {
    const draft = (await buildJournalFromEvent(chargeEvent))!;
    expect(draft.issueDate).toBe('2026-09-08');
    expect(draft.lines).toHaveLength(3);
  });

  // 手数料が展開されていないときに0円で通すと、手数料が費用に立たず静かにずれる。
  it('取りに行く手段が無ければ拒む（0円と推測しない）', async () => {
    const notExpanded = {
      ...chargeEvent,
      data: { object: { ...chargeEvent.data.object, balance_transaction: 'txn_1' } },
    };
    await expect(buildJournalFromEvent(notExpanded)).rejects.toThrow(/not expanded/);
  });

  // 実測: 実際のStripe Webhookでは balance_transaction は文字列IDか null で届く。
  // どちらも charge を取り直して手数料を得る。
  for (const [label, value] of [
    ['文字列ID', 'txn_abc'],
    ['null（決済直後は残高取引がまだ無い）', null],
  ] as const) {
    it(`balance_transaction が ${label} のとき、chargeを取り直して手数料を得る`, async () => {
      const notExpanded = {
        ...chargeEvent,
        data: { object: { ...chargeEvent.data.object, balance_transaction: value } },
      };
      let askedFor = '';
      const draft = (await buildJournalFromEvent(notExpanded, async (id) => {
        askedFor = id;
        return 36;
      }))!;
      // 取りに行く相手は balance_transaction ではなく charge の id。
      expect(askedFor).toBe('ch_1');
      expect(draft.lines).toEqual([
        { side: 'debit', account: 'accounts_receivable', amount: 964 },
        { side: 'debit', account: 'payment_fees', amount: 36 },
        { side: 'credit', account: 'sales', amount: 1000 },
      ]);
    });
  }

  it('対応しないイベントは null を返す', async () => {
    expect(
      await buildJournalFromEvent({
        id: 'evt_2',
        type: 'customer.created',
        created: 1788840000,
        data: { object: {} },
      })
    ).toBeNull();
  });

  it('payout.paid から入金の仕訳を作る', async () => {
    const draft = (await buildJournalFromEvent({
      id: 'evt_3',
      type: 'payout.paid',
      created: 1788840000,
      data: { object: { id: 'po_1', amount: 964, currency: 'jpy' } },
    }))!;
    expect(draft.lines[0]).toEqual({ side: 'debit', account: 'bank', amount: 964 });
  });
});

// 計上日は日本の帳簿の日付。UTCで切ると日本時間の朝9時前が前日付になり、
// 期末をまたぐと事業年度そのものがずれる。
describe('計上日はJSTで決める', () => {
  it('UNIX秒をYYYY-MM-DDにする', () => {
    expect(unixToDate(1788840000)).toBe('2026-09-08');
  });

  it('日本時間の朝9時前でも当日になる（UTCなら前日）', () => {
    expect(unixToDate(1788818400)).toBe('2026-09-08'); // 2026-09-08 07:00 JST
  });

  it('大晦日の夜は当年のまま', () => {
    expect(unixToDate(1798725600)).toBe('2026-12-31'); // 2026-12-31 23:00 JST
  });

  // UTCで切ると 2026-12-31 になり、前の事業年度へ計上されてしまう。
  it('元日の朝は翌年になる（事業年度をまたぐ）', () => {
    expect(unixToDate(1798758000)).toBe('2027-01-01'); // 2027-01-01 08:00 JST
  });
});
