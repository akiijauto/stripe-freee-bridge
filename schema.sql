-- stripe-freee-bridge の正本スキーマ。
-- 適用: npm run db:init（ローカル） / npm run db:init:remote（本番D1）

-- 受け取ったイベントの記録。Stripeはat-least-once配信なので、
-- ここに残っているイベントは二度処理しない（F-3 冪等性）。
CREATE TABLE IF NOT EXISTS processed_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 組み立てた仕訳案。freeeへ投入するのは人が承認してから（P2）。
CREATE TABLE IF NOT EXISTS journal_drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE REFERENCES processed_events(event_id),
  event_type   TEXT NOT NULL,
  issue_date   TEXT NOT NULL,
  memo         TEXT NOT NULL,
  lines_json   TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending / approved / posted / rejected
  -- freeeは一括削除APIを持たないため、投入したIDを残さないと取り消せない（F-7）。
  freee_manual_journal_id INTEGER,
  posted_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_journal_drafts_status ON journal_drafts (status, id DESC);

-- 仕訳にできなかったイベント。黙って捨てると、売上が1件抜けたことに誰も気づけない。
CREATE TABLE IF NOT EXISTS failed_events (
  event_id    TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- freeeのトークン。リフレッシュトークンは使うたびに入れ替わるため、
-- 実行中に書き換えられないWorkers Secretsではなくここに持つ。1行しか持たない。
CREATE TABLE IF NOT EXISTS freee_tokens (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  access_token     TEXT NOT NULL,
  refresh_token    TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  -- 同時更新を防ぐリース。この時刻を過ぎたロックは失効扱いにするので、
  -- 更新中に落ちても永久ロックにならない。
  refreshing_until TEXT
);
