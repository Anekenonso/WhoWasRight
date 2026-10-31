-- Migration 005: Persistent Quota Isolation & Atomic Counter
-- Enforces per-sport daily rate limiting with PostgreSQL atomic reservations.
-- Protects against process restarts, concurrent requests, and multi-instance drift.

BEGIN;

CREATE TABLE IF NOT EXISTS api_quota_usage (
  sport             VARCHAR(32) NOT NULL,
  usage_date        DATE NOT NULL,
  request_count     INT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sport, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_api_quota_usage_sport_date ON api_quota_usage(sport, usage_date);

-- Revoke public access to internal rate limit table
ALTER TABLE api_quota_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON api_quota_usage FROM PUBLIC, anon, authenticated;

COMMIT;
