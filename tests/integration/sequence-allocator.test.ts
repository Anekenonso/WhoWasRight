/**
 * Integration Tests: V2 Sequence Allocation & Database Constraints
 *
 * Verifies the database schema invariants, atomic sequence allocation,
 * rollback safety, and concurrency safety against an isolated PostgreSQL instance.
 *
 * GUARDED: Requires TEST_DATABASE_URL. Fails closed against production/DATABASE_URL.
 */

import { query, withTransaction, getDbPool } from './test-db.ts';
import { allocateNextEventSequence, getUserNextSequence } from '../../src/core/sequence-allocator.ts';
import { randomUUID } from 'node:crypto';

export async function runSequenceAllocatorIntegrationTests(): Promise<{
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

  console.log('\n--- Running V2 Sequence Allocator Integration Tests ---');

  // Test setup: create test users
  const userAId = randomUUID();
  const userBId = randomUUID();
  const telegramA = Math.floor(Math.random() * 1000000000);
  const telegramB = Math.floor(Math.random() * 1000000000);

  await query(`
    INSERT INTO users (id, telegram_id, username, first_name)
    VALUES ($1, $2, $3, 'TestUserA'), ($4, $5, $6, 'TestUserB');
  `, [userAId, telegramA, `v2_user_a_${Date.now()}`, userBId, telegramB, `v2_user_b_${Date.now()}`]);

  // Test 1: New user v2 sequence stream starts at 1
  let seq1 = 0;
  await withTransaction(async (client) => {
    seq1 = await allocateNextEventSequence(client, userAId);
  });
  assert(seq1 === 1, 'First sequence allocated for new user is 1');

  // Test 2: Sequential allocation produces contiguous numbers
  let seq2 = 0;
  let seq3 = 0;
  await withTransaction(async (client) => {
    seq2 = await allocateNextEventSequence(client, userAId);
    seq3 = await allocateNextEventSequence(client, userAId);
  });
  assert(seq2 === 2, 'Second sequence allocated is 2');
  assert(seq3 === 3, 'Third sequence allocated is 3');

  // Test 3: User B stream is completely independent and starts at 1
  let seqB1 = 0;
  await withTransaction(async (client) => {
    seqB1 = await allocateNextEventSequence(client, userBId);
  });
  assert(seqB1 === 1, 'User B stream starts at 1 independently of User A');

  // Test 4: Transaction rollback does not consume sequence numbers
  let seqRollbackAttempt = 0;
  try {
    await withTransaction(async (client) => {
      seqRollbackAttempt = await allocateNextEventSequence(client, userAId); // would be 4
      throw new Error('Forced transaction abort to test rollback safety');
    });
  } catch (err: any) {
    // Expected rollback
  }

  let seqAfterRollback = 0;
  await withTransaction(async (client) => {
    seqAfterRollback = await allocateNextEventSequence(client, userAId);
  });
  assert(seqAfterRollback === 4, 'Sequence after rolled-back transaction remains 4 (zero sequence consumption)');

  // Test 5: Concurrency safety — 10 concurrent transactions for the same user
  const concurrencyUser = randomUUID();
  await query(`
    INSERT INTO users (id, telegram_id, username, first_name)
    VALUES ($1, $2, $3, 'ConcurrentUser');
  `, [concurrencyUser, Math.floor(Math.random() * 1000000000), `v2_conc_${Date.now()}`]);

  const concurrentAllocations = await Promise.all(
    Array.from({ length: 10 }, () =>
      withTransaction(async (client) => {
        return allocateNextEventSequence(client, concurrencyUser);
      })
    )
  );

  concurrentAllocations.sort((a, b) => a - b);
  const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const isContiguous = JSON.stringify(concurrentAllocations) === JSON.stringify(expected);
  assert(isContiguous, '10 concurrent allocations produce contiguous sequences [1..10]');

  // Test 6: Database Check Constraint chk_outbox_format_sequence
  // Case 6a: v1 with sequence_number must fail check constraint
  let v1ViolationCaught = false;
  try {
    await query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, 'test-v1-invalid', 'payload', 'PENDING', 1, 1);
    `, [userAId]);
  } catch (err: any) {
    v1ViolationCaught = err.message.includes('chk_outbox_format_sequence');
  }
  assert(v1ViolationCaught, 'Check constraint rejects format_version=1 with non-null sequence_number');

  // Case 6b: v2 with NULL sequence_number must fail check constraint
  let v2NullViolationCaught = false;
  try {
    await query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, 'test-v2-invalid-null', 'payload', 'PENDING', 2, NULL);
    `, [userAId]);
  } catch (err: any) {
    v2NullViolationCaught = err.message.includes('chk_outbox_format_sequence');
  }
  assert(v2NullViolationCaught, 'Check constraint rejects format_version=2 with NULL sequence_number');

  // Case 6c: v2 with positive sequence succeeds
  const outboxRes = await query<{ id: string }>(`
    INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
    VALUES ($1, 'test-v2-valid-1', 'payload', 'PENDING', 2, 100)
    RETURNING id;
  `, [userAId]);
  const outboxId = outboxRes.rows[0].id;
  assert(!!outboxId, 'format_version=2 with positive sequence succeeds');

  // Test 7: Partial unique index uq_memory_outbox_user_seq
  let outboxDupCaught = false;
  try {
    await query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, 'test-v2-dup-seq', 'payload', 'PENDING', 2, 100);
    `, [userAId]);
  } catch (err: any) {
    outboxDupCaught = err.message.includes('uq_memory_outbox_user_seq');
  }
  assert(outboxDupCaught, 'Partial unique index uq_memory_outbox_user_seq prevents duplicate v2 sequences');

  // Test 8: Partial unique index uq_memory_receipts_outbox_id
  await query(`
    INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, outbox_id)
    VALUES ($1, 'test-ns', 100, 'CREATED', 'job-1', 'blob-1', $2);
  `, [userAId, outboxId]);

  let receiptDupCaught = false;
  try {
    await query(`
      INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id, outbox_id)
      VALUES ($1, 'test-ns-2', 101, 'CREATED', 'job-2', 'blob-2', $2);
    `, [userAId, outboxId]);
  } catch (err: any) {
    receiptDupCaught = err.message.includes('uq_memory_receipts_outbox_id');
  }
  assert(receiptDupCaught, 'Partial unique index uq_memory_receipts_outbox_id prevents multiple receipts per outbox row');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('sequence-allocator.test.ts')) {
  runSequenceAllocatorIntegrationTests()
    .then(result => {
      process.exitCode = result.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('Sequence Allocator Integration Test Error:', err);
      process.exitCode = 1;
    });
}

