// 承認された仕訳案をfreeeへ投入する。
//
// freeeには一括削除APIが無い（freee-setupが全96エンドポイントを走査して確認済み）。
// そのため**投入したIDを必ず記録する。**記録が無いと取り消す相手を探すところから始まる。

import { getAccessToken, type TokenEnv } from './freee-token';
import type { AccountKey, JournalLine } from './journal';

const MANUAL_JOURNALS_URL = 'https://api.freee.co.jp/api/1/manual_journals';

// 免税事業者なので税区分は「対象外」で統一する。
// テスト事業所(12785959)で code 2 = non_taxable「対象外」が available であることを実測済み。
const TAX_CODE_NON_TAXABLE = 2;

export interface PostEnv extends TokenEnv {
  FREEE_COMPANY_ID?: string;
  // 科目の対応づけ。抽象キー -> freeeのaccount_item_id。
  // 移行案件で「変換ではなく科目の対応づけが本体だった」と分かっているので、設定として外に出す。
  FREEE_ACCOUNT_IDS?: string; // 例: {"sales":123,"payment_fees":456,...}
  // 投入を禁止する事業所ID（カンマ区切り）。実帳簿を設定ミスで汚さないための安全弁。
  FREEE_BLOCKED_COMPANY_IDS?: string;
}

export class FreeePostError extends Error {}

export function resolveAccountMap(env: PostEnv): Record<AccountKey, number> {
  if (!env.FREEE_ACCOUNT_IDS) {
    throw new FreeePostError('FREEE_ACCOUNT_IDS が設定されていません');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(env.FREEE_ACCOUNT_IDS);
  } catch {
    throw new FreeePostError('FREEE_ACCOUNT_IDS がJSONとして読めません');
  }

  const map = {} as Record<AccountKey, number>;
  for (const [key, value] of Object.entries(parsed)) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new FreeePostError(`科目IDが不正: ${key}=${String(value)}`);
    }
    map[key as AccountKey] = id;
  }
  return map;
}

export interface PostResult {
  manualJournalId: number;
}

/**
 * 振替伝票として投入する。借方複数・貸方1つの複合仕訳を1件で表せるため、
 * 取引(deals)ではなく振替伝票(manual_journals)を使う。
 */
export async function postJournal(
  env: PostEnv,
  params: { issueDate: string; lines: JournalLine[]; memo: string }
): Promise<PostResult> {
  const companyId = Number(env.FREEE_COMPANY_ID);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new FreeePostError('FREEE_COMPANY_ID が設定されていません');
  }
  // 実帳簿へ投げない安全弁。設定ミスで本番の帳簿を汚さないよう、コード側でも止める。
  // 実際の事業所IDは公開リポジトリへ置かないので、設定から受け取る。
  const blocked = (env.FREEE_BLOCKED_COMPANY_IDS ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (blocked.includes(companyId)) {
    throw new FreeePostError(`投入が禁止されている事業所です: ${companyId}`);
  }

  const accountMap = resolveAccountMap(env);
  const details = params.lines.map((line) => {
    const accountItemId = accountMap[line.account];
    if (!accountItemId) {
      throw new FreeePostError(`科目の対応づけがありません: ${line.account}`);
    }
    return {
      entry_side: line.side,
      account_item_id: accountItemId,
      tax_code: TAX_CODE_NON_TAXABLE,
      amount: line.amount,
      // 摘要。どのStripe決済に対応する仕訳かを帳簿から追えるようにする。
      // これが無いと、freeeの画面を見ても突き合わせる手がかりが残らない。
      // 顧客名やメールアドレスは入れない（個人情報を帳簿へ持ち込まないため）。
      description: params.memo,
    };
  });

  const token = await getAccessToken(env);
  const res = await fetch(MANUAL_JOURNALS_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      company_id: companyId,
      issue_date: params.issueDate,
      details,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new FreeePostError(`freeeへの投入に失敗: HTTP ${res.status} ${body.slice(0, 300)}`);
  }

  const payload = (await res.json()) as { manual_journal?: { id?: number } };
  const id = payload.manual_journal?.id;
  if (!Number.isInteger(id)) {
    // IDが取れないと取り消せない。成功扱いにしない。
    throw new FreeePostError('投入は返ったが manual_journal.id が取れなかった');
  }
  return { manualJournalId: id as number };
}
