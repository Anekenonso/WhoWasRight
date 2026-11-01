/**
 * Walrus Memory Outbox Worker & Synchronization Engine
 *
 * Implements:
 * 1. Transactional Outbox processing with concurrency control (SKIP LOCKED).
 * 2. Idempotent submission to Walrus Memory Mainnet with confirmation waiting.
 * 3. Atomic transition to CONFIRMED and storage of verified receipts in `memory_receipts`.
 * 4. Exponential backoff and retry scheduling on transient failures.
 * 5. Full historical recall and deterministic credibility reconstruction.
 * 6. Protection against duplicate historical events and unconfirmed state claims.
 */

import { MemWal } from '@mysten-incubation/memwal';
import { getDbPool, query, withTransaction } from './db.ts';
import { parseStructuredMemory, getAppEncryptionKey } from './crypto.ts';
import { reconstructFromWalrusMemories, type ReconstructionReport } from './walrus-reconstruction.ts';

export interface ProcessOutboxResult {
  processed: number;
  confirmed: number;
  failed: number;
  retried: number;
  receipts: Array<{ id: string; userId: string; sequenceNumber: number; jobId: string; blobId: string }>;
}

export interface OutboxWorkerOptions {
  batchSize?: number;
  maxAttempts?: number;
  walrusClientOverride?: any;
  userId?: string;
  concurrent?: boolean;
  concurrency?: number;
}

/**
 * Creates a MemWal client for the specific user namespace
 */
export function getWalrusClientForUser(userId: string, overrideClient?: any): any {
  if (overrideClient) return overrideClient;

  const key = process.env.MEMWAL_KEY;
  const accountId = process.env.MEMWAL_ACCOUNT_ID;
  const serverUrl = process.env.MEMWAL_SERVER_URL || 'https://relayer.memory.walrus.xyz';
  const prefix = process.env.MEMWAL_NAMESPACE_PREFIX || 'wwr-';
  const namespace = `${prefix}${userId}`;

  if (!key || !accountId) {
    throw new Error('Walrus credentials missing: MEMWAL_KEY and MEMWAL_ACCOUNT_ID must be set');
  }

  return MemWal.create({
    key,
    accountId,
    serverUrl,
    namespace,
  });
}

/**
 * Processes pending items from memory_outbox with concurrency protection and exponential backoff
 */
export async function processMemoryOutbox(options: OutboxWorkerOptions = {}): Promise<ProcessOutboxResult> {
  const batchSize = options.batchSize || 10;
  const maxAttempts = options.maxAttempts || 5;

  const pool = getDbPool();
  const client = await pool.connect();

  const result: ProcessOutboxResult = {
    processed: 0,
    confirmed: 0,
    failed: 0,
    retried: 0,
    receipts: [],
  };

  try {
    // 1. Lock batch of eligible outbox records (SKIP LOCKED prevents worker contention)
    // Demo accounts (telegram_id < 0) are strictly excluded at database level from Walrus writes
    await client.query('BEGIN');
    const queryParams: any[] = [batchSize];
    let userFilter = '';
    if (options.userId) {
      queryParams.push(options.userId);
      userFilter = ` AND mo.user_id = $${queryParams.length}`;
    }

    const outboxRes = await client.query<{
      id: string;
      user_id: string;
      event_key: string;
      payload: string;
      attempts: number;
      format_version?: number;
      sequence_number?: string | number | null;
      walrus_job_id?: string | null;
    }>(`
      SELECT mo.id, mo.user_id, mo.event_key, mo.payload, mo.attempts,
             mo.format_version, mo.sequence_number, mo.walrus_job_id
      FROM memory_outbox mo
      JOIN users u ON u.id = mo.user_id
      WHERE mo.status = 'PENDING'
        AND mo.next_retry_at <= NOW()
        AND u.telegram_id > 0${userFilter}
      ORDER BY mo.created_at ASC
      LIMIT $1
      FOR UPDATE OF mo SKIP LOCKED;
    `, queryParams);

    if (outboxRes.rows.length === 0) {
      await client.query('COMMIT');
      return result;
    }

    // Mark locked items as IN_FLIGHT
    const ids = outboxRes.rows.map(r => r.id);
    await client.query(`
      UPDATE memory_outbox
      SET status = 'IN_FLIGHT', updated_at = NOW()
      WHERE id = ANY($1::uuid[]);
    `, [ids]);
    await client.query('COMMIT');

    // 2. Process outbox items (sequentially by default, concurrently if option set)
    const processSingleItem = async (item: typeof outboxRes.rows[0]) => {
      result.processed++;

      const parsed = parseStructuredMemory(item.payload);
      if (!parsed) {
        // Corrupted payload format in outbox; fail permanently
        await pool.query(`
          UPDATE memory_outbox
          SET status = 'FAILED', error_message = 'Malformed structured memory format in outbox', updated_at = NOW()
          WHERE id = $1;
        `, [item.id]);
        result.failed++;
        return;
      }

      const prefix = process.env.MEMWAL_NAMESPACE_PREFIX || 'wwr-';
      const namespace = `${prefix}${item.user_id}`;
      const sequenceNumber = item.sequence_number ? Number(item.sequence_number) : parsed.sequenceNumber;

      // 2a. Reconciliation: Check if a confirmed receipt already exists (avoids duplicate Walrus writes)
      try {
        const existingReceipt = await pool.query<{ job_id: string; blob_id: string; proof_reference: string | null }>(`
          SELECT job_id, blob_id, proof_reference
          FROM memory_receipts
          WHERE outbox_id = $1
             OR (user_id = $2 AND namespace = $3 AND sequence_number = $4)
          LIMIT 1;
        `, [item.id, item.user_id, namespace, sequenceNumber]);

        if (existingReceipt.rows.length > 0) {
          const r = existingReceipt.rows[0];
          await withTransaction(async (txClient) => {
            await txClient.query(`
              UPDATE memory_receipts
              SET outbox_id = COALESCE(outbox_id, $1)
              WHERE user_id = $2 AND namespace = $3 AND sequence_number = $4;
            `, [item.id, item.user_id, namespace, sequenceNumber]);

            await txClient.query(`
              UPDATE memory_outbox
              SET status = 'CONFIRMED', walrus_job_id = $1, error_message = NULL, updated_at = NOW()
              WHERE id = $2;
            `, [r.job_id, item.id]);
          });

          result.confirmed++;
          result.receipts.push({
            id: item.id,
            userId: item.user_id,
            sequenceNumber,
            jobId: r.job_id,
            blobId: r.blob_id,
          });
          return;
        }
      } catch (recErr: any) {
        // If table doesn't have outbox_id yet or query error, log and continue to Walrus submission
        console.warn(`[WALRUS RECONCILIATION CHECK WARNING]:`, recErr?.message || recErr);
      }

      try {
        let jobId: string = '';
        let blobId: string = '';
        let proofRef: string | null = null;

        // 2b. If walrus_job_id was already recorded, await its confirmation rather than resending
        if (item.walrus_job_id) {
          try {
            if (options.walrusClientOverride?.waitForRememberJob) {
              const pollRes = await options.walrusClientOverride.waitForRememberJob(item.walrus_job_id);
              jobId = pollRes.job_id || pollRes.id || item.walrus_job_id;
              blobId = pollRes.blob_id;
              proofRef = pollRes.owner || null;
            } else if (!options.walrusClientOverride) {
              const walrus = getWalrusClientForUser(item.user_id);
              const pollRes = await walrus.waitForRememberJob(item.walrus_job_id, { timeoutMs: 120000 });
              jobId = pollRes.job_id || pollRes.id || item.walrus_job_id;
              blobId = pollRes.blob_id;
              proofRef = pollRes.owner || null;
            }
          } catch (pollErr: any) {
            console.warn(`[WALRUS RESUME JOB WARNING for ${item.walrus_job_id}]:`, pollErr?.message || pollErr);
          }
        }

        // 2c. Write to Walrus if not resolved from resumed job (passes idempotencyKey to prevent duplicate payment/writes)
        if (!jobId || !blobId) {
          if (options.walrusClientOverride) {
            // Used in unit/mock tests
            const mockRes = await options.walrusClientOverride.rememberAndWait(item.payload, {
              idempotencyKey: item.id,
              timeoutMs: 30000,
            });
            jobId = mockRes.job_id || mockRes.id || `mock-job-${Date.now()}`;
            blobId = mockRes.blob_id || `mock-blob-${Date.now()}`;
            proofRef = mockRes.owner || null;
          } else {
            // Live Walrus Mainnet Integration
            const walrus = getWalrusClientForUser(item.user_id);
            const writeRes = await walrus.rememberAndWait(item.payload, {
              idempotencyKey: item.id,
              timeoutMs: 120000,
            });
            jobId = writeRes.job_id || writeRes.id;
            blobId = writeRes.blob_id;
            proofRef = writeRes.owner || null;
          }
        }

        // 3. Atomically record confirmed receipt and update outbox status to CONFIRMED
        await withTransaction(async (txClient) => {
          // Insert receipt with outbox_id (idempotent ON CONFLICT)
          await txClient.query(`
            INSERT INTO memory_receipts (
              user_id, namespace, sequence_number, event_type, job_id, blob_id, proof_reference, confirmed_at, outbox_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)
            ON CONFLICT (user_id, namespace, sequence_number) DO UPDATE
            SET blob_id = EXCLUDED.blob_id,
                job_id = EXCLUDED.job_id,
                outbox_id = COALESCE(memory_receipts.outbox_id, EXCLUDED.outbox_id);
          `, [item.user_id, namespace, sequenceNumber, parsed.eventType, jobId, blobId, proofRef, item.id]);

          // Update outbox status to CONFIRMED
          await txClient.query(`
            UPDATE memory_outbox
            SET status = 'CONFIRMED', walrus_job_id = $1, error_message = NULL, updated_at = NOW()
            WHERE id = $2;
          `, [jobId, item.id]);
        });

        result.confirmed++;
        result.receipts.push({
          id: item.id,
          userId: item.user_id,
          sequenceNumber,
          jobId,
          blobId,
        });

      } catch (err: any) {
        console.log(`[WALRUS RETRY item ${item.id}]:`, err?.message || err);
        const nextAttempts = item.attempts + 1;
        const errorMsg = err.message || 'Walrus write failure';

        if (nextAttempts >= maxAttempts) {
          // Terminal failure
          await pool.query(`
            UPDATE memory_outbox
            SET status = 'FAILED', attempts = $1, error_message = $2, updated_at = NOW()
            WHERE id = $3;
          `, [nextAttempts, errorMsg, item.id]);
          result.failed++;
        } else {
          // Bounded exponential backoff: min(2^attempts, 300) seconds
          const backoffSeconds = Math.min(Math.pow(2, nextAttempts), 300);
          await pool.query(`
            UPDATE memory_outbox
            SET status = 'PENDING', attempts = $1, error_message = $2,
                next_retry_at = NOW() + ($3 || ' seconds')::interval,
                updated_at = NOW()
            WHERE id = $4;
          `, [nextAttempts, errorMsg, backoffSeconds, item.id]);
          result.retried++;
        }
      }
    };

    const concurrency = options.concurrency || (options.concurrent ? 2 : 1);
    for (let i = 0; i < outboxRes.rows.length; i += concurrency) {
      const chunk = outboxRes.rows.slice(i, i + concurrency);
      await Promise.all(chunk.map(processSingleItem));
    }

  } finally {
    client.release();
  }

  return result;
}

/**
 * Reconstructs analyst predictions and credibility from confirmed Walrus Memory records
 */
export async function reconstructUserHistoryFromWalrus(
  userId: string,
  targetAnalystId?: string,
  options?: {
    rawMemoriesOverride?: string[];
    errorOverride?: Error;
  }
): Promise<ReconstructionReport> {
  if (options?.errorOverride) {
    throw options.errorOverride;
  }

  let rawMemories: string[];
  if (options?.rawMemoriesOverride) {
    rawMemories = options.rawMemoriesOverride;
  } else {
    // Query all confirmed memory payloads for the user in sequence
    const res = await query<{ payload: string }>(`
      SELECT o.payload
      FROM memory_receipts r
      JOIN memory_outbox o ON o.user_id = r.user_id AND o.walrus_job_id = r.job_id
      WHERE r.user_id = $1
      ORDER BY r.sequence_number ASC;
    `, [userId]);

    rawMemories = res.rows.map(r => r.payload);
  }

  const encryptionKey = getAppEncryptionKey();

  return reconstructFromWalrusMemories(rawMemories, targetAnalystId, encryptionKey);
}

/**
 * Recovers crashed IN_FLIGHT outbox items that have been stale longer than staleMinutes
 */
export async function recoverStaleInFlightOutbox(staleMinutes = 5): Promise<number> {
  const pool = getDbPool();
  const res = await pool.query(`
    UPDATE memory_outbox
    SET status = 'PENDING',
        attempts = attempts + 1,
        next_retry_at = NOW(),
        error_message = 'Recovered from stale IN_FLIGHT state after worker interruption',
        updated_at = NOW()
    WHERE status = 'IN_FLIGHT'
      AND updated_at < NOW() - ($1 || ' minutes')::interval
    RETURNING id;
  `, [staleMinutes]);

  return res.rowCount || 0;
}

/**
 * Recovers a FAILED outbox item back to PENDING for manual or administrative retry
 */
export async function resetFailedOutboxItem(id: string): Promise<boolean> {
  const pool = getDbPool();
  const res = await pool.query(`
    UPDATE memory_outbox
    SET status = 'PENDING',
        attempts = 0,
        error_message = NULL,
        next_retry_at = NOW(),
        updated_at = NOW()
    WHERE id = $1 AND status = 'FAILED'
    RETURNING id;
  `, [id]);

  return (res.rowCount || 0) > 0;
}

export interface OutboxStatusSummary {
  synced: number;     // CONFIRMED
  pending: number;    // PENDING
  inFlight: number;   // IN_FLIGHT
  failed: number;     // FAILED
  total: number;
}

/**
 * Returns explicit summary counts of outbox states (synced, pending, failed)
 */
export async function getOutboxStatusSummary(userId?: string): Promise<OutboxStatusSummary> {
  const pool = getDbPool();
  const params: any[] = [];
  let userCondition = '';
  if (userId) {
    params.push(userId);
    userCondition = 'WHERE user_id = $1';
  }

  const res = await pool.query<{ status: string; count: string }>(`
    SELECT status, COUNT(*)::text AS count
    FROM memory_outbox
    ${userCondition}
    GROUP BY status;
  `, params);

  const summary: OutboxStatusSummary = {
    synced: 0,
    pending: 0,
    inFlight: 0,
    failed: 0,
    total: 0,
  };

  for (const row of res.rows) {
    const count = parseInt(row.count, 10);
    summary.total += count;
    if (row.status === 'CONFIRMED') summary.synced += count;
    else if (row.status === 'PENDING') summary.pending += count;
    else if (row.status === 'IN_FLIGHT') summary.inFlight += count;
    else if (row.status === 'FAILED') summary.failed += count;
  }

  return summary;
}
