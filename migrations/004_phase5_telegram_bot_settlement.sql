-- Migration 004: Phase 5 — Telegram Bot Linking & Settlement Infrastructure
-- Idempotent. Apply once. Do not modify after deployment.
-- All tables are in the public schema but protected by RLS.

BEGIN;

-- ============================================================
-- 1. Bot Link Tokens (single-use, short-lived linking challenge)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_link_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    TEXT NOT NULL UNIQUE,          -- SHA-256 of the plaintext token
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
  used_at       TIMESTAMPTZ,                   -- NULL = unused; set atomically on use
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_link_tokens_user ON bot_link_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_link_tokens_expires ON bot_link_tokens(expires_at);

-- RLS: users may only read their own tokens; all writes are server-side (service role)
ALTER TABLE bot_link_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'bot_link_tokens' AND policyname = 'users_own_tokens'
  ) THEN
    CREATE POLICY users_own_tokens ON bot_link_tokens
      FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
  END IF;
END $$;
REVOKE ALL ON bot_link_tokens FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. Bot Links (verified Telegram chat ↔ WhoWasRight user)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_links (
  user_id           UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id  BIGINT NOT NULL,           -- confirmed Telegram chat_id from bot
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  linked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE bot_links ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_links_chat_id ON bot_links(telegram_chat_id);

ALTER TABLE bot_links ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'bot_links' AND policyname = 'users_own_bot_link'
  ) THEN
    CREATE POLICY users_own_bot_link ON bot_links
      FOR SELECT USING (user_id = current_setting('app.current_user_id', true)::uuid);
  END IF;
END $$;
REVOKE ALL ON bot_links FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. Notification Queue (durable Telegram message delivery)
-- ============================================================
CREATE TABLE IF NOT EXISTS notification_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prediction_id     UUID REFERENCES predictions(id) ON DELETE SET NULL,
  notification_type TEXT NOT NULL CHECK (notification_type IN (
    'SETTLEMENT_AUTO',     -- API-verified result notification
    'SETTLEMENT_MANUAL',   -- Manual settlement prompt with inline buttons
    'CORRECTION'           -- User-initiated correction notification
  )),
  payload_json      JSONB NOT NULL,            -- Full message content, not secrets
  idempotency_key   TEXT NOT NULL UNIQUE,      -- Stable key to prevent duplicate sends
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING', 'SENDING', 'SENT', 'FAILED', 'BLOCKED'
  )),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at           TIMESTAMPTZ,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notif_queue_status ON notification_queue(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_notif_queue_user ON notification_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_notif_queue_prediction ON notification_queue(prediction_id);

ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_queue FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 4. Settlement Jobs (track polling state per fixture)
-- ============================================================
CREATE TABLE IF NOT EXISTS settlement_jobs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_fixture_id        INTEGER NOT NULL UNIQUE,
  status                TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',       -- Not yet settled
    'SETTLED',       -- All predictions for fixture resolved
    'PARTIAL',       -- Some predictions resolved, some unsupported/manual
    'FAILED',        -- API consistently unavailable
    'MANUAL_ONLY'    -- No supported auto-settle markets
  )),
  last_polled_at        TIMESTAMPTZ,
  settled_predictions   INTEGER NOT NULL DEFAULT 0,
  manual_predictions    INTEGER NOT NULL DEFAULT 0,
  error                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_settlement_jobs_status ON settlement_jobs(status);

ALTER TABLE settlement_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON settlement_jobs FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 5. Record migration
-- ============================================================
INSERT INTO _migrations (name, applied_at)
VALUES ('004_phase5_telegram_bot_settlement.sql', NOW())
ON CONFLICT (name) DO NOTHING;

COMMIT;

