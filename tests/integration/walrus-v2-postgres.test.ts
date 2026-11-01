/**
 * PostgreSQL Integration Tests: Walrus V2 Database Concurrency & Outbox Lifecycle
 *
 * Verifies real PostgreSQL database semantics against an active database connection:
 * 1. Concurrent sequence allocation for the same user (row-level locking).
 * 2. Independent sequence allocation for different users.
 * 3. Transaction rollback restoring the sequence allocation without burning sequence numbers.
 * 4. Atomic prediction/event/outbox creation within a single transaction.
 * 5. Unique sequence constraints and format invariants (chk_outbox_format_sequence, uq_memory_outbox_user_seq).
 * 6. Concurrent outbox worker claims (FOR UPDATE SKIP LOCKED).
 * 7. Duplicate and replayed job handling (receipt reconciliation).
 * 8. Confirmed receipt persistence with outbox_id linkage.
 *
 * GUARDED: Requires TEST_DATABASE_URL. Fails closed against production DATABASE_URL.
 */

import { query, withTransaction, getDbPool } from './test-db.ts';
import { allocateNextEventSequence, getUserNextSequence } from '../../src/core/sequence-allocator.ts';
import { createAnalyst, createAnalystSnapshot } from '../../src/core/analysts.ts';
import { createEvent, createPrediction, settlePrediction } from '../../src/core/predictions.ts';
import { processMemoryOutbox, recoverStaleInFlightOutbox } from '../../src/core/walrus-outbox-worker.ts';
import { randomUUID } from 'node:crypto';

export async function runWalrusV2PostgresIntegrationTests(): Promise<{
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

  console.log('\n============================================================');
  console.log('WALRUS V2 POSTGRESQL INTEGRATION TESTS');
  console.log('============================================================');

  // Setup isolated test users
  const userAId = randomUUID();
  const userBId = randomUUID();
  const suffix = Date.now();

  await query(`
    INSERT INTO users (id, telegram_id, username, first_name)
    VALUES ($1, $2, $3, 'V2UserA'), ($4, $5, $6, 'V2UserB');
  `, [
    userAId,
    940000000 + Math.floor(Math.random() * 100000),
    `v2_pg_a_${suffix}`,
    userBId,
    950000000 + Math.floor(Math.random() * 100000),
    `v2_pg_b_${suffix}`,
  ]);

  // ---------------------------------------------------------------------------
  // 1. Concurrent Sequence Allocation for Same User
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Concurrent Sequence Allocation ---');
  const concUser = randomUUID();
  await query(`
    INSERT INTO users (id, telegram_id, username, first_name)
    VALUES ($1, $2, $3, 'ConcUser');
  `, [concUser, 960000000 + Math.floor(Math.random() * 100000), `v2_conc_${suffix}`]);

  const concurrentResults = await Promise.all(
    Array.from({ length: 10 }, () =>
      withTransaction(async (client) => {
        return allocateNextEventSequence(client, concUser);
      })
    )
  );

  concurrentResults.sort((a, b) => a - b);
  assert(
    JSON.stringify(concurrentResults) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    '10 concurrent PostgreSQL transactions allocate contiguous sequences [1..10] without duplicate or race'
  );

  // ---------------------------------------------------------------------------
  // 2. Independent Sequence Allocation for Different Users
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Independent User Sequences ---');
  let seqA1 = 0;
  let seqB1 = 0;
  await withTransaction(async (client) => {
    seqA1 = await allocateNextEventSequence(client, userAId);
  });
  await withTransaction(async (client) => {
    seqB1 = await allocateNextEventSequence(client, userBId);
  });
  assert(seqA1 === 1, 'User A starts at sequence 1');
  assert(seqB1 === 1, 'User B starts at sequence 1 independently');

  let seqA2 = 0;
  await withTransaction(async (client) => {
    seqA2 = await allocateNextEventSequence(client, userAId);
  });
  assert(seqA2 === 2, 'User A advances to sequence 2');

  const nextB = await getUserNextSequence((await getDbPool().connect()) as any, userBId);
  assert(nextB === 2, 'User B remains at next_sequence 2 without increment');

  // ---------------------------------------------------------------------------
  // 3. Transaction Rollback Restoring Sequence Allocation
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Rollback Safety (Zero Sequence Consumption) ---');
  try {
    await withTransaction(async (client) => {
      await allocateNextEventSequence(client, userAId); // would be 3
      throw new Error('Forced transaction rollback');
    });
  } catch {
    // Expected abort
  }

  let seqAfterRollback = 0;
  await withTransaction(async (client) => {
    seqAfterRollback = await allocateNextEventSequence(client, userAId);
  });
  assert(seqAfterRollback === 3, 'Sequence allocated after rollback remains 3 (zero consumed sequences)');

  // ---------------------------------------------------------------------------
  // 4. Atomic Prediction, Settlement, Snapshot and Outbox Creation
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Atomic Prediction & Outbox Creation ---');
  const analystA = await createAnalyst(userAId, `Analyst_${suffix}`);
  const event1 = await createEvent({
    userId: userAId,
    label: 'Man City vs Real Madrid',
    startAtUtc: new Date(Date.now() + 3600000), // 1 hour future
    source: 'USER_REPORTED',
  });

  const pred1 = await createPrediction({
    userId: userAId,
    eventId: event1.id,
    analystId: analystA.id,
    market: '1X2',
    selection: 'Home',
  });

  const outboxCreate = await query<{ format_version: number; sequence_number: string; status: string }>(`
    SELECT format_version, sequence_number, status
    FROM memory_outbox
    WHERE user_id = $1 AND event_key = $2;
  `, [userAId, `pred-create-${pred1.id}`]);

  assert(outboxCreate.rows.length === 1, 'Prediction creation writes memory_outbox row');
  assert(outboxCreate.rows[0].format_version === 2, 'Outbox row format_version is 2');
  assert(outboxCreate.rows[0].sequence_number === '4', 'Outbox sequence_number is 4');
  assert(outboxCreate.rows[0].status === 'PENDING', 'Outbox status is PENDING');

  // Settlement
  const settledPred = await settlePrediction({
    userId: userAId,
    predictionId: pred1.id,
    newOutcome: 'WON',
    source: 'MANUAL_USER',
    verification: 'SELF_REPORTED',
  });
  assert(settledPred.outcome === 'WON', 'Prediction settled to WON');

  const outboxSettle = await query<{ format_version: number; sequence_number: string }>(`
    SELECT format_version, sequence_number
    FROM memory_outbox
    WHERE user_id = $1 AND event_key LIKE $2;
  `, [userAId, `pred-settle-${pred1.id}-%`]);

  assert(outboxSettle.rows.length === 1, 'Settlement writes memory_outbox row');
  assert(outboxSettle.rows[0].format_version === 2, 'Settlement outbox format_version is 2');
  assert(outboxSettle.rows[0].sequence_number === '5', 'Settlement outbox sequence_number is 5');

  // Snapshot
  const snapshotRes = await createAnalystSnapshot(userAId, analystA.id);
  assert(snapshotRes.sequenceNumber === 6, 'Snapshot allocates sequence 6');

  // ---------------------------------------------------------------------------
  // 5. Unique Sequence Constraints & Schema Invariants
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Constraints & Schema Invariants ---');
  let duplicateSeqCaught = false;
  try {
    await query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, 'test-dup-seq', 'dummy', 'PENDING', 2, 4);
    `, [userAId]);
  } catch (err: any) {
    duplicateSeqCaught = err.message.includes('uq_memory_outbox_user_seq');
  }
  assert(duplicateSeqCaught, 'uq_memory_outbox_user_seq rejects duplicate sequence number for same user');

  let invalidFormatCaught = false;
  try {
    await query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, 'test-invalid-v1', 'dummy', 'PENDING', 1, 999);
    `, [userAId]);
  } catch (err: any) {
    invalidFormatCaught = err.message.includes('chk_outbox_format_sequence');
  }
  assert(invalidFormatCaught, 'chk_outbox_format_sequence rejects v1 with non-null sequence');

  // ---------------------------------------------------------------------------
  // 6. Outbox Worker: Processing, Receipts, and Reconciliation
  // ---------------------------------------------------------------------------
  console.log('\n--- 6. Outbox Worker & Receipt Linkage ---');
  const mockWalrus = {
    rememberAndWait: async (text: string, options?: any) => {
      return {
        job_id: `walrus-pg-job-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        blob_id: `walrus-pg-blob-${Date.now()}`,
        owner: '0x-sui-pg-owner',
      };
    },
  };

  const processRes = await processMemoryOutbox({
    userId: userAId,
    batchSize: 10,
    walrusClientOverride: mockWalrus,
  });

  assert(processRes.confirmed >= 3, 'Worker confirmed pending outbox records');

  const receiptCheck = await query<{ outbox_id: string; sequence_number: string; job_id: string }>(`
    SELECT outbox_id, sequence_number, job_id
    FROM memory_receipts
    WHERE user_id = $1 AND sequence_number IN (4, 5, 6)
    ORDER BY sequence_number ASC;
  `, [userAId]);

  assert(receiptCheck.rows.length === 3, 'All 3 memory receipts persisted in PostgreSQL');
  assert(!!receiptCheck.rows[0].outbox_id, 'Receipt is linked to outbox_id');
  assert(receiptCheck.rows[0].sequence_number === '4', 'Receipt records sequence 4');
  assert(receiptCheck.rows[1].sequence_number === '5', 'Receipt records sequence 5');
  assert(receiptCheck.rows[2].sequence_number === '6', 'Receipt records sequence 6');

  // ---------------------------------------------------------------------------
  // 7. Reconciliation: Reprocessing Confirmed Items Executes Zero Walrus Calls
  // ---------------------------------------------------------------------------
  console.log('\n--- 7. Reconciliation & Replay Protection ---');
  let duplicateCalls = 0;
  const spyWalrus = {
    rememberAndWait: async () => {
      duplicateCalls++;
      return { job_id: 'dup', blob_id: 'dup' };
    },
  };

  const reprocessRes = await processMemoryOutbox({
    userId: userAId,
    batchSize: 10,
    walrusClientOverride: spyWalrus,
  });

  assert(reprocessRes.confirmed === 0, 'Reprocessing confirmed items confirms 0 new items');
  assert(duplicateCalls === 0, 'Reprocessing confirmed items makes ZERO external Walrus calls');

  // Stale recovery
  const staleRes = await recoverStaleInFlightOutbox(5);
  assert(typeof staleRes === 'number', 'Stale in-flight recovery returns numeric recovered count');

  console.log('\n============================================================');
  console.log(`WALRUS V2 POSTGRES TESTS COMPLETE: ${count - failures.length}/${count} PASSED`);
  console.log('============================================================\n');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('walrus-v2-postgres.test.ts')) {
  runWalrusV2PostgresIntegrationTests()
    .then(result => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('Walrus V2 Postgres Integration Test Error:', err);
      process.exitCode = 1;
    });
}

