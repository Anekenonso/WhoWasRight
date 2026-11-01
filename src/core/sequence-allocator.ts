/**
 * V2 Sequence Allocator
 *
 * Implements transaction-safe, per-user sequence number allocation for Walrus Memory events.
 *
 * Invariants:
 * 1. Sequences are strictly positive integers starting at 1 for each user.
 * 2. Allocations must occur within an active PostgreSQL transaction alongside the outbox insertion.
 * 3. Rolling back the transaction rolls back the counter increment, ensuring zero consumed sequences on failure.
 * 4. Format version 1 events have sequence_number = NULL; format version 2 events have sequence_number > 0.
 */

import type pg from 'pg';

export interface SequenceAllocationResult {
  userId: string;
  sequenceNumber: number;
}

/**
 * Validates the schema invariant between format_version and sequence_number.
 */
export function validateOutboxFormatInvariant(
  formatVersion: number,
  sequenceNumber: number | null
): boolean {
  if (formatVersion === 1) {
    return sequenceNumber === null;
  }
  if (formatVersion === 2) {
    return typeof sequenceNumber === 'number' && Number.isInteger(sequenceNumber) && sequenceNumber > 0;
  }
  return false;
}

/**
 * Allocates the next monotonic sequence number for a user within an active transaction.
 *
 * CRITICAL TRANSACTION CONTRACT:
 * - Must be called with a transaction-scoped `pg.PoolClient` (e.g. inside `withTransaction(async (client) => ...)`).
 * - A general connection pool (`pg.Pool`) is explicitly rejected at runtime to prevent atomicity breaks.
 * - The caller MUST execute this allocation AND the corresponding `memory_outbox` insertion
 *   within the exact same transaction on this `client`.
 * - If the transaction rolls back, PostgreSQL rolls back the `user_event_sequences` counter,
 *   guaranteeing zero consumed or skipped sequence numbers on failure.
 */
export async function allocateNextEventSequence(
  client: pg.PoolClient,
  userId: string
): Promise<number> {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('Sequence allocation requires a valid non-empty userId');
  }

  if (
    !client ||
    typeof client.query !== 'function' ||
    typeof (client as any).release !== 'function' ||
    'totalCount' in client
  ) {
    throw new Error('Sequence allocation requires an active PostgreSQL transaction client (PoolClient), not a connection Pool');
  }

  // 1. Ensure the user counter row exists with next_sequence = 1
  await client.query(`
    INSERT INTO user_event_sequences (user_id, next_sequence, updated_at)
    VALUES ($1, 1, NOW())
    ON CONFLICT (user_id) DO NOTHING;
  `, [userId]);

  // 2. Atomically lock the row, increment counter, and return the allocated sequence
  const res = await client.query<{ allocated_sequence: string }>(`
    UPDATE user_event_sequences
    SET next_sequence = next_sequence + 1,
        updated_at = NOW()
    WHERE user_id = $1
    RETURNING (next_sequence - 1) AS allocated_sequence;
  `, [userId]);

  if (res.rows.length === 0) {
    throw new Error(`Failed to allocate sequence for user "${userId}": counter row not found`);
  }

  const allocated = Number(res.rows[0].allocated_sequence);
  if (!Number.isSafeInteger(allocated) || allocated < 1) {
    throw new Error(`Invalid sequence number allocated for user "${userId}": ${allocated}`);
  }

  return allocated;
}

/**
 * Reads the current next_sequence for a user without incrementing.
 * Returns null if no sequence record exists yet.
 */
export async function getUserNextSequence(
  client: pg.PoolClient,
  userId: string
): Promise<number | null> {
  if (!userId || typeof userId !== 'string') {
    throw new Error('Valid userId required');
  }

  if (
    !client ||
    typeof client.query !== 'function' ||
    typeof (client as any).release !== 'function' ||
    'totalCount' in client
  ) {
    throw new Error('Reading sequence requires an active PostgreSQL client (PoolClient), not a connection Pool');
  }

  const res = await client.query<{ next_sequence: string }>(`
    SELECT next_sequence 
    FROM user_event_sequences
    WHERE user_id = $1;
  `, [userId]);

  if (res.rows.length === 0) {
    return null;
  }

  return Number(res.rows[0].next_sequence);
}

