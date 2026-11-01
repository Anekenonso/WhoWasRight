-- Migration 006: V2 Sequence Foundation & Allocation Hardening
-- Establishes transactional per-user sequence allocation, format versioning (v1 vs v2),
-- and relational receipt binding for Walrus Memory events.

BEGIN;

-- 1. Create persistent per-user sequence counter table for v2 event streams
CREATE TABLE IF NOT EXISTS user_event_sequences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  next_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_sequence >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Secure internal table via RLS
ALTER TABLE user_event_sequences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_event_sequences FROM PUBLIC, anon, authenticated;
GRANT ALL ON user_event_sequences TO postgres, service_role;

-- 2. Expand memory_outbox with format_version and sequence_number
ALTER TABLE memory_outbox
  ADD COLUMN IF NOT EXISTS format_version INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sequence_number BIGINT NULL;

-- 3. Add check constraint enforcing strict v1/v2 schema invariant
ALTER TABLE memory_outbox
  DROP CONSTRAINT IF EXISTS chk_outbox_format_sequence;

ALTER TABLE memory_outbox
  ADD CONSTRAINT chk_outbox_format_sequence
  CHECK (
    (format_version = 1 AND sequence_number IS NULL) OR
    (format_version = 2 AND sequence_number > 0)
  );

-- 4. Create partial unique index to enforce unique v2 sequence numbers per user
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_outbox_user_seq
  ON memory_outbox (user_id, sequence_number)
  WHERE sequence_number IS NOT NULL;

-- 5. Expand memory_receipts with direct outbox_id reference
ALTER TABLE memory_receipts
  ADD COLUMN IF NOT EXISTS outbox_id UUID NULL REFERENCES memory_outbox(id) ON DELETE RESTRICT;

-- 6. Create partial unique index ensuring 1:1 association between outbox jobs and receipts
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_receipts_outbox_id
  ON memory_receipts (outbox_id)
  WHERE outbox_id IS NOT NULL;

COMMIT;

