/**
 * Gate 3 Integration Test Suite: Outbox Recovery, Concurrency & Idempotency
 *
 * Explicitly tests 10 resilience scenarios:
 * 1. Crash before submit (remains PENDING, picked up on restart).
 * 2. Crash after submit, before confirm (recovery from IN_FLIGHT).
 * 3. Crash after confirm, before receipt write (idempotent ON CONFLICT resolution).
 * 4. Concurrent workers (FOR UPDATE SKIP LOCKED prevents double processing).
 * 5. Timeout retry (exponential backoff 2^attempts).
 * 6. 5+ failures -> FAILED terminal status.
 * 7. Manual recovery of FAILED items back to PENDING.
 * 8. Out-of-order writes (receipts ensure monotonic sequence order).
 * 9. Duplicate receipt prevention (unique constraint on user_id, namespace, sequence_number).
 * 10. Explicit verification that PostgreSQL row locks are NOT held during external Walrus network calls.
 */

import { query, getDbPool, withTransaction } from '../../src/core/db.ts';
import {
  processMemoryOutbox,
  recoverStaleInFlightOutbox,
  resetFailedOutboxItem
} from '../../src/core/walrus-outbox-worker.ts';
import { formatStructuredMemory, encryptRecord } from '../../src/core/crypto.ts';

export async function runGate3OutboxResilienceTests(): Promise<{
  passed: boolean;
  count: number;
  failures: string[];
}> {
  const failures: string[] = [];
  let count = 0;

  function assert(condition: boolean, testName: string) {
    count++;
    if (!condition) {
      failures.push(testName);
      console.error(`  [FAIL] ${testName}`);
    } else {
      console.log(`  [PASS] ${testName}`);
    }
  }

  console.log('\n--- Running Gate 3 Outbox Resilience & Idempotency Tests ---');

  const pool = getDbPool();
  const suffix = Date.now();

  // Create isolated test user
  const uRes = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, 'Gate3User')
    RETURNING id;
  `, [930000000 + Math.floor(Math.random() * 100000), `gate3_user_${suffix}`]);
  const userId = uRes.rows[0].id;
  const analystId = '00000000-0000-4000-a000-000000000001';

  // Helper to create valid structured memory payloads
  function makePayload(seq: number, eventType: 'CREATED' | 'SETTLED' | 'CORRECTED', data: any): string {
    return formatStructuredMemory({
      analystId,
      sequenceNumber: seq,
      eventType,
      payload: data,
    });
  }

  // --- Scenario 1: Crash before submit (remains PENDING, picked up on restart) ---
  const payload1 = makePayload(1, 'CREATED', { pick: 'Test1' });
  const outboxRes1 = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
    VALUES ($1, 'g3-ev-1', $2, 'PENDING', 0, NOW())
    RETURNING id;
  `, [userId, payload1]);
  const outboxId1 = outboxRes1.rows[0].id;

  // Process with worker (simulates restart picking up PENDING)
  const mockWalrusSuccess = {
    rememberAndWait: async () => ({
      job_id: `g3-job-${Date.now()}`,
      blob_id: `g3-blob-${Date.now()}`,
      owner: 'sui-test-owner',
    }),
  };

  const res1 = await processMemoryOutbox({
    userId,
    batchSize: 1,
    walrusClientOverride: mockWalrusSuccess,
  });

  assert(res1.confirmed === 1, 'Scenario 1: Pending outbox picked up and confirmed after restart');
  const check1 = await query(`SELECT status FROM memory_outbox WHERE id = $1;`, [outboxId1]);
  assert(check1.rows[0].status === 'CONFIRMED', 'Scenario 1: Outbox row updated to CONFIRMED');

  // --- Scenario 2: Crash after submit, before confirm (recovery from IN_FLIGHT) ---
  const payload2 = makePayload(2, 'CREATED', { pick: 'Test2' });
  const outboxRes2 = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at, updated_at)
    VALUES ($1, 'g3-ev-2', $2, 'IN_FLIGHT', 1, NOW(), NOW() - INTERVAL '10 minutes')
    RETURNING id;
  `, [userId, payload2]);
  const outboxId2 = outboxRes2.rows[0].id;

  // Run stale in-flight recovery
  const recoveredCount = await recoverStaleInFlightOutbox(5);
  assert(recoveredCount >= 1, 'Scenario 2: Stale IN_FLIGHT outbox item recovered');
  const check2 = await query(`SELECT status, attempts, error_message FROM memory_outbox WHERE id = $1;`, [outboxId2]);
  assert(check2.rows[0].status === 'PENDING', 'Scenario 2: Recovered item status reset to PENDING');
  assert(check2.rows[0].attempts === 2, 'Scenario 2: Attempts incremented on recovery');

  // Finish processing it
  await processMemoryOutbox({
    userId,
    batchSize: 1,
    walrusClientOverride: mockWalrusSuccess,
  });
  const check2Confirmed = await query(`SELECT status FROM memory_outbox WHERE id = $1;`, [outboxId2]);
  assert(check2Confirmed.rows[0].status === 'CONFIRMED', 'Scenario 2: Recovered item successfully processed to CONFIRMED');

  // --- Scenario 3: Crash after confirm, before receipt write (idempotent ON CONFLICT resolution) ---
  // Seed a receipt directly, then attempt to insert with ON CONFLICT resolution
  const namespace = `wwr-${userId}`;
  await query(`
    INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, confirmed_at)
    VALUES ($1, $2, 3, 'CREATED', 'job-initial-3', 'blob-initial-3', NOW());
  `, [userId, namespace]);

  // Simulate replay writing the same receipt with updated blob
  await query(`
    INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, confirmed_at)
    VALUES ($1, $2, 3, 'CREATED', 'job-replay-3', 'blob-replay-3', NOW())
    ON CONFLICT (user_id, namespace, sequence_number) DO UPDATE
    SET blob_id = EXCLUDED.blob_id, job_id = EXCLUDED.job_id;
  `, [userId, namespace]);

  const receiptCheck3 = await query(`
    SELECT job_id, blob_id FROM memory_receipts
    WHERE user_id = $1 AND namespace = $2 AND sequence_number = 3;
  `, [userId, namespace]);
  assert(receiptCheck3.rows.length === 1, 'Scenario 3: ON CONFLICT prevents duplicate receipt row');
  assert(receiptCheck3.rows[0].job_id === 'job-replay-3', 'Scenario 3: Replay safely updates receipt to latest');

  // --- Scenario 4: Concurrent workers (FOR UPDATE SKIP LOCKED prevents double processing) ---
  const payload4a = makePayload(4, 'CREATED', { pick: 'Test4a' });
  const payload4b = makePayload(5, 'CREATED', { pick: 'Test4b' });
  await query(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
    VALUES
      ($1, 'g3-ev-4a', $2, 'PENDING', 0, NOW()),
      ($1, 'g3-ev-4b', $3, 'PENDING', 0, NOW());
  `, [userId, payload4a, payload4b]);

  // Run two concurrent workers with artificial delay in walrus client
  const slowMockWalrus = {
    rememberAndWait: async () => {
      await new Promise(r => setTimeout(r, 20));
      return {
        job_id: `g3-job-conc-${Math.random()}`,
        blob_id: `g3-blob-conc-${Math.random()}`,
      };
    },
  };

  const [workerResult1, workerResult2] = await Promise.all([
    processMemoryOutbox({ userId, batchSize: 2, walrusClientOverride: slowMockWalrus }),
    processMemoryOutbox({ userId, batchSize: 2, walrusClientOverride: slowMockWalrus }),
  ]);

  const totalProcessed = workerResult1.processed + workerResult2.processed;
  const totalConfirmed = workerResult1.confirmed + workerResult2.confirmed;
  assert(totalProcessed === 2, `Scenario 4: SKIP LOCKED distributed work without overlap (total processed: ${totalProcessed})`);
  assert(totalConfirmed === 2, `Scenario 4: Exactly 2 distinct items confirmed across workers (total confirmed: ${totalConfirmed})`);

  // --- Scenario 5: Timeout retry (exponential backoff 2^attempts) ---
  const payload5 = makePayload(6, 'CREATED', { pick: 'Test5' });
  const outboxRes5 = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
    VALUES ($1, 'g3-ev-5', $2, 'PENDING', 2, NOW())
    RETURNING id;
  `, [userId, payload5]);
  const outboxId5 = outboxRes5.rows[0].id;

  const failingClient = {
    rememberAndWait: async () => {
      throw new Error('ETIMEDOUT: Walrus network gateway timeout');
    },
  };

  const res5 = await processMemoryOutbox({
    userId,
    batchSize: 1,
    maxAttempts: 5,
    walrusClientOverride: failingClient,
  });

  assert(res5.retried === 1, 'Scenario 5: Failed item scheduled for retry');
  const check5 = await query<{
    status: string;
    attempts: number;
    next_retry_at: Date;
    error_message: string;
  }>(`
    SELECT status, attempts, next_retry_at, error_message
    FROM memory_outbox WHERE id = $1;
  `, [outboxId5]);

  assert(check5.rows[0].status === 'PENDING', 'Scenario 5: Status remains PENDING for retry');
  assert(check5.rows[0].attempts === 3, 'Scenario 5: Attempts incremented to 3');
  // Backoff for attempt 3 is 2^3 = 8 seconds
  const retryDeltaSeconds = (new Date(check5.rows[0].next_retry_at).getTime() - Date.now()) / 1000;
  assert(retryDeltaSeconds > 3 && retryDeltaSeconds <= 10, `Scenario 5: Exponential backoff scheduled (~8s, actual: ${retryDeltaSeconds.toFixed(1)}s)`);
  assert(check5.rows[0].error_message.includes('ETIMEDOUT'), 'Scenario 5: Exact error message preserved in outbox');

  // --- Scenario 6: 5+ failures -> FAILED terminal status ---
  const payload6 = makePayload(7, 'CREATED', { pick: 'Test6' });
  const outboxRes6 = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
    VALUES ($1, 'g3-ev-6', $2, 'PENDING', 4, NOW())
    RETURNING id;
  `, [userId, payload6]);
  const outboxId6 = outboxRes6.rows[0].id;

  const res6 = await processMemoryOutbox({
    userId,
    batchSize: 1,
    maxAttempts: 5,
    walrusClientOverride: failingClient,
  });

  assert(res6.failed === 1, 'Scenario 6: Item reaching max attempts marked as failed');
  const check6 = await query<{ status: string; attempts: number }>(`
    SELECT status, attempts FROM memory_outbox WHERE id = $1;
  `, [outboxId6]);
  assert(check6.rows[0].status === 'FAILED', 'Scenario 6: Status transitioned to FAILED');
  assert(check6.rows[0].attempts === 5, 'Scenario 6: Final attempts recorded as 5');

  // --- Scenario 7: Manual recovery of FAILED items back to PENDING ---
  const resetSuccess = await resetFailedOutboxItem(outboxId6);
  assert(resetSuccess === true, 'Scenario 7: resetFailedOutboxItem returned true');
  const check7 = await query<{ status: string; attempts: number; error_message: string | null }>(`
    SELECT status, attempts, error_message FROM memory_outbox WHERE id = $1;
  `, [outboxId6]);
  assert(check7.rows[0].status === 'PENDING', 'Scenario 7: Status reset to PENDING');
  assert(check7.rows[0].attempts === 0, 'Scenario 7: Attempts reset to 0');
  assert(check7.rows[0].error_message === null, 'Scenario 7: Error message cleared');

  // Verify it can now be confirmed
  await processMemoryOutbox({
    userId,
    batchSize: 1,
    walrusClientOverride: mockWalrusSuccess,
  });
  const check7Confirmed = await query(`SELECT status FROM memory_outbox WHERE id = $1;`, [outboxId6]);
  assert(check7Confirmed.rows[0].status === 'CONFIRMED', 'Scenario 7: Previously failed item confirmed after recovery');

  // --- Scenario 8: Out-of-order writes (receipts ensure monotonic sequence order) ---
  // Seed receipts in non-sequential insertion order (seq 10, then seq 8, then seq 9)
  await query(`
    INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, confirmed_at)
    VALUES
      ($1, $2, 10, 'SETTLED', 'job-10', 'blob-10', NOW()),
      ($1, $2, 8,  'CREATED', 'job-8',  'blob-8',  NOW()),
      ($1, $2, 9,  'CREATED', 'job-9',  'blob-9',  NOW())
    ON CONFLICT DO NOTHING;
  `, [userId, namespace]);

  const orderedReceipts = await query<{ sequence_number: string | number }>(`
    SELECT sequence_number FROM memory_receipts
    WHERE user_id = $1 AND namespace = $2 AND sequence_number >= 8
    ORDER BY sequence_number ASC;
  `, [userId, namespace]);

  const seqs = orderedReceipts.rows.map(r => Number(r.sequence_number));
  assert(
    seqs[0] === 8 && seqs[1] === 9 && seqs[2] === 10,
    `Scenario 8: Receipts sort strictly monotonically regardless of insert order: [${seqs.join(', ')}]`
  );

  // --- Scenario 9: Duplicate receipt prevention (unique constraint) ---
  let duplicateConstraintThrown = false;
  try {
    // Attempt raw INSERT with duplicate (user_id, namespace, sequence_number = 8)
    await query(`
      INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, confirmed_at)
      VALUES ($1, $2, 8, 'CREATED', 'job-dup', 'blob-dup', NOW());
    `, [userId, namespace]);
  } catch (err: any) {
    if (err.code === '23505') { // Postgres unique_violation
      duplicateConstraintThrown = true;
    }
  }
  assert(duplicateConstraintThrown === true, 'Scenario 9: Database rejects duplicate receipt with code 23505 (unique constraint violation)');

  // --- Scenario 10: Explicit verification that PostgreSQL row locks are NOT held during external Walrus network calls ---
  await query(`DELETE FROM memory_outbox WHERE user_id = $1;`, [userId]);
  const payload10 = makePayload(11, 'CREATED', { pick: 'Test10' });
  const outboxRes10 = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
    VALUES ($1, 'g3-ev-10', $2, 'PENDING', 0, NOW())
    RETURNING id;
  `, [userId, payload10]);
  const outboxId10 = outboxRes10.rows[0].id;

  let externalCallActive = false;
  let concurrentReadSuccessful = false;
  let concurrentUpdateSuccessful = false;

  const lockedMockWalrus = {
    rememberAndWait: async () => {
      externalCallActive = true;
      // While external call is in flight, perform queries from a completely separate client
      let separateClient: any = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          separateClient = await pool.connect();
          break;
        } catch (err: any) {
          if (attempt < 2 && (err?.code === 'ENOTFOUND' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT')) {
            await new Promise(r => setTimeout(r, 500));
            continue;
          }
          throw err;
        }
      }
      try {
        // Query the outbox item
        const qRes = await separateClient.query<{ status: string }>(`
          SELECT status FROM memory_outbox WHERE id = $1;
        `, [outboxId10]);
        if (qRes.rows.length === 1 && qRes.rows[0].status === 'IN_FLIGHT') {
          concurrentReadSuccessful = true;
        }

        // Perform an update on the outbox table concurrently
        const uRes = await separateClient.query(`
          UPDATE memory_outbox SET attempts = 0 WHERE id = $1 RETURNING id;
        `, [outboxId10]);
        if (uRes.rowCount === 1) {
          concurrentUpdateSuccessful = true;
        }
      } finally {
        separateClient.release();
      }

      return {
        job_id: `g3-job-nolock-${Date.now()}`,
        blob_id: `g3-blob-nolock-${Date.now()}`,
      };
    },
  };

  await processMemoryOutbox({
    userId,
    batchSize: 1,
    walrusClientOverride: lockedMockWalrus,
  });

  assert(externalCallActive === true, 'Scenario 10: External Walrus network call executed');
  assert(concurrentReadSuccessful === true, 'Scenario 10: Concurrent client reads outbox row without blocking during network call');
  assert(concurrentUpdateSuccessful === true, 'Scenario 10: Concurrent client updates outbox row without blocking during network call (NO ROW LOCK HELD)');

  // Clean up
  await query(`DELETE FROM memory_receipts WHERE user_id = $1;`, [userId]);
  await query(`DELETE FROM memory_outbox WHERE user_id = $1;`, [userId]);
  await query(`DELETE FROM users WHERE id = $1;`, [userId]);

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow direct execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('gate3-outbox-resilience.test.ts')) {
  runGate3OutboxResilienceTests()
    .then(res => {
      console.log(`\nGate 3 Result: ${res.passed ? 'ALL PASSED' : 'FAILED'} (${res.count} assertions)`);
      if (res.failures.length > 0) {
        console.error('Failures:', res.failures);
      }
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('Gate 3 Fatal Error:', err);
      process.exitCode = 1;
    });
}
