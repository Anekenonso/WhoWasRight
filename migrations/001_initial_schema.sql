-- =============================================================================
-- Migration 001: Initial Schema for WhoWasRight
-- PostgreSQL 17+ compatible with UUIDs, RLS, and strict foreign keys
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. Users Table (Telegram-Only Authentication, No Emails)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    telegram_id BIGINT UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    notifications_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users(deleted_at);

-- -----------------------------------------------------------------------------
-- 2. Sessions Table (Opaque Session Tokens Hashed via SHA-256)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- -----------------------------------------------------------------------------
-- 3. Analysts Table (User-Private Analysts)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_analyst_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_analysts_user_id ON analysts(user_id);

-- -----------------------------------------------------------------------------
-- 4. Analyst Aliases (Multi-Platform Identity Linking)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analyst_aliases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analyst_id UUID NOT NULL REFERENCES analysts(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN ('TELEGRAM', 'TWITTER', 'YOUTUBE', 'TIKTOK', 'OTHER')),
    handle TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_analyst_platform_handle UNIQUE (analyst_id, platform, handle)
);

CREATE INDEX IF NOT EXISTS idx_analyst_aliases_analyst_id ON analyst_aliases(analyst_id);
CREATE INDEX IF NOT EXISTS idx_analyst_aliases_handle ON analyst_aliases(platform, handle);

-- -----------------------------------------------------------------------------
-- 5. Events Table (Matches / Fixtures with Strict Kickoff & Status)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sport TEXT NOT NULL DEFAULT 'FOOTBALL',
    label TEXT NOT NULL,
    api_fixture_id BIGINT,
    start_at_utc TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('API_SPORTS', 'USER_REPORTED', 'SYNTHETIC_SAMPLE')),
    ever_started BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'TIMED' CHECK (status IN ('TIMED', 'IN_PLAY', 'FINISHED', 'POSTPONED', 'CANCELLED', 'ABANDONED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_start_at_utc ON events(start_at_utc);
CREATE INDEX IF NOT EXISTS idx_events_api_fixture_id ON events(api_fixture_id);

-- -----------------------------------------------------------------------------
-- 6. Predictions Table (Picks, Markets, Outbox & Settlement State)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS predictions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    analyst_id UUID NOT NULL REFERENCES analysts(id) ON DELETE CASCADE,
    market TEXT NOT NULL,
    selection TEXT NOT NULL,
    raw_text TEXT,
    created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome TEXT NOT NULL DEFAULT 'PENDING' CHECK (outcome IN ('PENDING', 'WON', 'LOST', 'PUSH', 'VOID', 'UNSUPPORTED_REQUIRES_MANUAL')),
    verification TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (verification IN ('API_VERIFIED', 'SELF_REPORTED', 'UNVERIFIED')),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Exact Duplicate Guard: Same analyst cannot have exact same market+selection on same event
    CONSTRAINT uq_user_event_analyst_market_selection UNIQUE (user_id, event_id, analyst_id, market, selection)
);

CREATE INDEX IF NOT EXISTS idx_predictions_user_id ON predictions(user_id);
CREATE INDEX IF NOT EXISTS idx_predictions_event_id ON predictions(event_id);
CREATE INDEX IF NOT EXISTS idx_predictions_analyst_id ON predictions(analyst_id);
CREATE INDEX IF NOT EXISTS idx_predictions_outcome ON predictions(outcome);

-- -----------------------------------------------------------------------------
-- 7. Outcome Events Table (Audit Log of Outcome Transitions)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outcome_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prediction_id UUID NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
    old_outcome TEXT NOT NULL,
    new_outcome TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('AUTOMATED_API', 'MANUAL_USER', 'CORRECTION')),
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outcome_events_prediction_id ON outcome_events(prediction_id);

-- -----------------------------------------------------------------------------
-- 8. Memory Outbox Table (Transactional Outbox Pattern for Walrus Sync)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_FLIGHT', 'CONFIRMED', 'FAILED')),
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    walrus_job_id TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_outbox_event_key UNIQUE (user_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_outbox_status_retry ON memory_outbox(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_memory_outbox_user_id ON memory_outbox(user_id);

-- -----------------------------------------------------------------------------
-- 9. Memory Receipts Table (Confirmed Walrus Memory References & Blob IDs)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    sequence_number BIGINT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'SETTLED', 'CORRECTED', 'ANALYST_MERGED', 'SNAPSHOT')),
    job_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    proof_reference TEXT,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_namespace_seq UNIQUE (user_id, namespace, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_memory_receipts_user_seq ON memory_receipts(user_id, namespace, sequence_number);
CREATE INDEX IF NOT EXISTS idx_memory_receipts_blob_id ON memory_receipts(blob_id);

-- -----------------------------------------------------------------------------
-- 10. Bot Links Table (Telegram Bot Notification Preference)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bot_links (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    telegram_chat_id BIGINT UNIQUE NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- 11. Fixture Cache Table (API-Sports Quota Protection: 100 req/day Limit)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixture_cache (
    api_fixture_id BIGINT PRIMARY KEY,
    data JSONB NOT NULL,
    status TEXT NOT NULL,
    kickoff_utc TIMESTAMPTZ NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fixture_cache_expires ON fixture_cache(expires_at);

-- -----------------------------------------------------------------------------
-- 12. Row Level Security (RLS) Setup
-- -----------------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysts ENABLE ROW LEVEL SECURITY;
ALTER TABLE analyst_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_links ENABLE ROW LEVEL SECURITY;

-- Note: When the application backend connects via service_role/superuser direct connection,
-- RLS policies provide database-level defense-in-depth when session variables are set:
CREATE POLICY user_isolation_analysts ON analysts
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY user_isolation_events ON events
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY user_isolation_predictions ON predictions
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY user_isolation_outbox ON memory_outbox
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

CREATE POLICY user_isolation_receipts ON memory_receipts
    FOR ALL
    USING (user_id = NULLIF(current_setting('app.current_user_id', true), '')::uuid);

