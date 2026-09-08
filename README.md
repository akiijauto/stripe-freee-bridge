# stripe-freee-bridge

**Stripeで受けた売上を、freee会計の仕訳へ計上するための連携。**（Cloudflare Workers + D1）

Stripeの入金は**手数料が差し引かれた金額**で銀行口座へ届く。通帳の数字だけを見て記帳すると、
売上が手数料のぶん小さく計上される。これを売上総額と支払手数料に分けて立て、
入金があった時点で未収入金を消し込むところまでを扱う。

## 仕訳の形

1,000円の売上で手数料が36円だった場合。

**売上計上時**（`charge.succeeded`）

| 借方 | | 貸方 | |
| --- | --- | --- | --- |
| 未収入金（Stripe） | 964 | 売上高 | 1,000 |
| 支払手数料 | 36 | | |

**入金時**（`payout.paid`）

| 借方 | | 貸方 | |
| --- | --- | --- | --- |
| 普通預金 | 964 | 未収入金（Stripe） | 964 |

**返金時**（`charge.refunded`）— Stripeは返金しても決済手数料を返さないため、支払手数料は戻さない

| 借方 | | 貸方 | |
| --- | --- | --- | --- |
| 売上高 | 1,000 | 未収入金（Stripe） | 1,000 |

## 設計で気をつけていること

- **AIは仕訳案を出すだけで、freeeへは投入しない。** 投入は人が承認してから行う。
  freeeには一括削除APIが無いため、間違えて入れると1件ずつ消すことになる
- **同じイベントを2回受けても二重計上しない。** Stripeはat-least-once配信なので、
  同じWebhookが複数回届く。処理済みのイベントIDをD1に残して弾く
- **貸借が一致しない仕訳は保存しない**
- **計上日はJST(UTC+9)で決める。** UTCのまま日付を切ると日本時間の朝9時前の取引が前日付になり、
  1月1日の朝の売上が前事業年度（12月31日）へ落ちる
- **手数料が取れないときは0円と推測しない。** 実測では、Webhookのpayloadの
  `balance_transaction` は **null**（決済直後は残高取引がまだ無い）か文字列IDで届く。
  その場合はStripe APIでchargeを取り直して手数料を得る。取れなければ仕訳にせず、
  500を返してStripeに再送させる。0円で通すと手数料が費用に立たず、**貸借は合うので静かにずれる**
- **円以外の通貨は拒む。** 円は最小単位が1円だが、ドル等はセントなので同じ扱いにすると100倍ずれる
- **仕訳にできなかったイベントを黙って捨てない。** 捨てると売上が1件抜けたことに誰も気づけない

## 状態

| 段階 | 内容 | 状態 |
| --- | --- | --- |
| P1 | Webhookの受け口・署名検証・冪等性・仕訳案の組み立て | **完了** |
| P2 | freee APIへの投入（テスト用事業所が相手） | **完了**（実投入を別経路で検算済み） |
| P3 | 入金消込・返金 | **完了**（売上・入金・返金の3種を実投入して確認） |
| P4 | **毎日の照合と通知** | **完了**（StripeとfreeeをCronで突き合わせ、差があるときだけDiscordへ） |

**本番稼働中**: `https://stripe-freee-bridge.akiij-auto.workers.dev`

**StripeのWebhookエンドポイントも登録済みで、実際の決済から仕訳ができることを確認済み。**
対象イベントは `charge.succeeded` / `charge.refunded` / `payout.paid`。

**実帳簿へは書き込まない。** 相手はfreeeのテスト用事業所（`12785959`）に限る。
実帳簿（本番の事業所）を指定した場合は**コード側で投入を止める**（設定ミスで本番の帳簿を汚さないため）。

### freeeのトークンの持ち方

freeeのリフレッシュトークンは**使うたびに入れ替わる。**実行中に書き換えられない
Workers Secretsには置けないので、D1の `freee_tokens`（1行）に持つ。

Workersは並行実行されるため、2つのリクエストが同時に更新すると**片方が死ぬ**
（死ぬとブラウザでの再認可からやり直しになる）。D1の条件付きUPDATEで
**リースを取った実行だけが更新する。**リースには期限があるので、更新中に落ちても永久ロックにならない。

**freee-setup とは別のfreeeアプリ（別の client_id）を使う。**同じアプリを共有すると、
片方がトークンを更新した瞬間にもう片方が死ぬため。

## セットアップ

```bash
npm install
npm run cf-typegen

npx wrangler login
npx wrangler d1 create stripe-freee-bridge

# wrangler.jsonc（公開テンプレート）を複製して実IDを書き込む。複製先は.gitignore済み。
cp wrangler.jsonc wrangler.local.jsonc
# wrangler.local.jsonc の REPLACE_WITH_D1_DATABASE_ID を実IDに置き換える

npm run db:init          # ローカルD1
npm run db:init:remote   # 本番D1

# StripeのWebhook署名シークレット
npx wrangler secret put STRIPE_WEBHOOK_SECRET -c wrangler.local.jsonc
```

## 開発・テスト

```bash
npm run dev    # ローカル起動。秘密は --var で渡すか .dev.vars に置く（.dev.vars は.gitignore済み）
npm test       # vitest（53件）
npm run deploy # 本番へデプロイ
```

ローカルで署名付きリクエストを試すには、`.dev.vars.example` を `.dev.vars` へ複製して
テスト用の値を入れるか、`wrangler dev --var STRIPE_WEBHOOK_SECRET:whsec_test_secret` で渡す。

## 照合（P4）

**仕組みが「止まった」ことには気付けても、「1件だけ抜けた」ことには気付けない。**
Stripeの再送には回数の限りがあり、諦められた時点で売上が抜けたまま誰も気付かなくなる。
そこで毎日 JST 07:00 に Cron で突き合わせ、**差があるときだけ**Discordへ通知する（静かなのが正常）。

| 見るもの | 突き合わせ方 |
| --- | --- |
| 売上 | Stripeのcharge総額 ↔ freeeの売上高（返金は差し引く） |
| 支払手数料 | Stripeのfee合計 ↔ freeeの支払手数料 |
| 取りこぼし | `failed_events` に残っているもの（**error**） |
| 承認待ち | `pending` のまま放置されている仕訳案（**warn**） |

承認待ちが残っているうちは金額が合わなくて当然なので、**その間は金額差では鳴らさない。**
鳴りっぱなしの見張りは無視されるようになる。

手動でも走らせられる: `POST /admin/reconcile`（管理トークン必須）

## エンドポイント

- `POST /webhook/stripe` — Stripe Webhookの受け口（署名検証あり）
- `GET /` — 仕訳案の確認画面
- `GET /api/drafts` — 仕訳案（JSON）
- `POST /admin/reconcile` — 照合を手動実行（管理トークン必須）
- `POST /admin/freee/authorize` — freeeの認可コードを受け取る（管理トークン必須）

## ドキュメント

- `docs/要件定義.md` — 何を・なぜ・どこまで
- `docs/振り返り.md` — 開発中に実際に起きた問題と対処
