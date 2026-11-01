/**
 * Integration Tests: Phase 3 "Remember Slice" & Walrus Synchronization
 *
 * Verifies:
 * 1. Transactional outbox creation upon prediction logging.
 * 2. Outbox worker processing: pending -> confirmed, receipt generation.
 * 3. Idempotency and duplicate prevention.
 * 4. Transient failure recovery with exponential backoff.
 * 5. Exact retrieval, envelope parsing, and AES-256-GCM decryption.
 * 6. Sequence integrity, gap detection, and ciphertext tamper detection.
 * 7. Full credibility reconstruction purely from Walrus event stream.
 * 8. User isolation in Walrus memory namespaces.
 * 9. Automated football settlement, outcome audit events, and outbox sync.
 */

import { query, withTransaction } from './test-db.ts';
import { createAnalyst } from '../../src/core/analysts.ts';
import { createEvent, createPrediction } from '../../src/core/predictions.ts';
import { processMemoryOutbox, reconstructUserHistoryFromWalrus } from '../../src/core/walrus-outbox-worker.ts';
import { executeAutomatedSettlement } from '../../src/core/settlement.ts';
import { formatStructuredMemory, parseStructuredMemory, decryptRecord, getAppEncryptionKey } from '../../src/core/crypto.ts';
import { reconstructFromWalrusMemories } from '../../src/core/walrus-reconstruction.ts';

export async function runPhase3RememberSliceIntegrationTests(): Promise<{
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

  console.log('\n--- Running Phase 3 Remember Slice & Walrus Integration Tests ---');

  // Setup Test Users
  const suffix = Date.now();
  const uResA = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, 'UserA')
    RETURNING id;
  `, [910000000 + Math.floor(Math.random() * 100000), `user_a_${suffix}`]);
  const userA = uResA.rows[0].id;

  const uResB = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, 'UserB')
    RETURNING id;
  `, [920000000 + Math.floor(Math.random() * 100000), `user_b_${suffix}`]);
  const userB = uResB.rows[0].id;

  try {
    const analystA = await createAnalyst(userA, 'Gary Neville');
    const kickoff = new Date(Date.now() + 7200000); // 2 hours future
    const event1 = await createEvent({
      userId: userA,
      label: 'Arsenal vs Chelsea',
      startAtUtc: kickoff,
      source: 'USER_REPORTED',
    });

    // 1. Transactional Outbox Creation
    const pred1 = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analystA.id,
      market: '1X2',
      selection: 'Arsenal',
    });

    const pendingOutbox = await query(`
      SELECT id, status, payload, attempts FROM memory_outbox
      WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred1.id}`]);

    assert(pendingOutbox.rows.length === 1, 'Prediction creation atomically enqueues memory outbox record');
    assert(pendingOutbox.rows[0].status === 'PENDING', 'Initial outbox status is PENDING');
    assert(pendingOutbox.rows[0].attempts === 0, 'Initial attempts count is 0');

    // 2. Outbox Processing with Simulated / Controlled Walrus Client
    const mockWalrusClient = {
      rememberAndWait: async (text: string) => {
        return {
          job_id: `walrus-job-${Date.now()}`,
          blob_id: `walrus-blob-${Date.now()}`,
          owner: `sui-owner-ref-${Date.now()}`,
        };
      },
    };

    const processRes = await processMemoryOutbox({
      batchSize: 10,
      walrusClientOverride: mockWalrusClient,
      userId: userA,
    });

    assert(processRes.confirmed >= 1, 'Outbox worker successfully confirmed pending record');

    const confirmedOutbox = await query(`
      SELECT status, walrus_job_id FROM memory_outbox
      WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred1.id}`]);
    assert(confirmedOutbox.rows[0].status === 'CONFIRMED', 'Outbox record transitioned to CONFIRMED');
    assert(!!confirmedOutbox.rows[0].walrus_job_id, 'Outbox record holds confirmed walrus_job_id');

    const receipt = await query(`
      SELECT namespace, sequence_number, event_type, job_id, blob_id FROM memory_receipts
      WHERE user_id = $1 AND job_id = $2;
    `, [userA, confirmedOutbox.rows[0].walrus_job_id]);
    assert(receipt.rows.length === 1, 'Memory receipt saved in database');
    assert(receipt.rows[0].event_type === 'CREATED', 'Receipt records event_type CREATED');
    assert(receipt.rows[0].sequence_number === '1', 'First event has sequence_number 1');

    // 3. Idempotency Test: Reprocessing produces 0 new confirmations
    const reprocess = await processMemoryOutbox({
      batchSize: 10,
      walrusClientOverride: mockWalrusClient,
      userId: userA,
    });
    assert(reprocess.confirmed === 0, 'Reprocessing confirmed outbox items processes 0 records (idempotent)');

    // 4. Transient Failure & Exponential Backoff Test
    const pred2 = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analystA.id,
      market: 'BTTS',
      selection: 'Yes',
    });

    const failingClient = {
      rememberAndWait: async () => {
        throw new Error('Simulated Walrus 503 Service Unavailable');
      },
    };

    const failRun = await processMemoryOutbox({
      batchSize: 10,
      walrusClientOverride: failingClient,
      userId: userA,
    });
    assert(failRun.retried === 1, 'Transient failure marked for retry');

    const retryingOutbox = await query(`
      SELECT id, status, attempts, error_message, next_retry_at FROM memory_outbox
      WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred2.id}`]);
    assert(retryingOutbox.rows[0].status === 'PENDING', 'Failed item resets to PENDING for retry');
    assert(retryingOutbox.rows[0].attempts === 1, 'Attempts incremented to 1');
    assert(retryingOutbox.rows[0].error_message.includes('503'), 'Error message recorded');

    // Force retry window and process with recovered client
    await query(`
      UPDATE memory_outbox
      SET next_retry_at = NOW() - INTERVAL '1 second'
      WHERE id = $1;
    `, [retryingOutbox.rows[0].id]);

    const recoverRun = await processMemoryOutbox({
      batchSize: 10,
      walrusClientOverride: mockWalrusClient,
      userId: userA,
    });
    assert(recoverRun.confirmed === 1, 'Recovered from temporary outage; confirmed on retry');

    // 5. Automated Settlement & Outcome Event Synchronization
    const settleRes = await executeAutomatedSettlement({
      userId: userA,
      predictionId: pred1.id,
      evidence: {
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        homeGoals: 2,
        awayGoals: 1,
        status: 'FINISHED',
      },
    });
    assert(settleRes.outcome === 'WON', 'Arsenal 2-1 settles pred1 (Arsenal 1X2) as WON');
    assert(settleRes.verification === 'API_VERIFIED', 'Verification marked API_VERIFIED');

    // Settle pred2 (BTTS Yes on 2-1)
    const settleRes2 = await executeAutomatedSettlement({
      userId: userA,
      predictionId: pred2.id,
      evidence: {
        homeTeam: 'Arsenal',
        awayTeam: 'Chelsea',
        homeGoals: 2,
        awayGoals: 1,
        status: 'FINISHED',
      },
    });
    assert(settleRes2.outcome === 'WON', 'Arsenal 2-1 settles pred2 (BTTS Yes) as WON');

    // Process outbox for the settlement events
    await processMemoryOutbox({
      batchSize: 10,
      walrusClientOverride: mockWalrusClient,
      userId: userA,
    });

    // 6. Exact Retrieval & AES-256-GCM Decryption Test
    const outboxRecord = await query(`
      SELECT payload FROM memory_outbox WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred1.id}`]);

    const parsedEnvelope = parseStructuredMemory(outboxRecord.rows[0].payload);
    assert(parsedEnvelope !== null, 'Structured memory envelope parses successfully');
    assert(parsedEnvelope?.analystId === analystA.id, 'Analyst ID matches in envelope');
    assert(parsedEnvelope?.eventType === 'CREATED', 'Event type matches in envelope');

    const decrypted = decryptRecord<any>(parsedEnvelope!.encryptedPayload);
    assert(decrypted.predictionId === pred1.id, 'Decrypted payload matches original prediction ID');
    assert(decrypted.market === '1X2', 'Decrypted market is 1X2');
    assert(decrypted.selection === 'Arsenal', 'Decrypted selection is Arsenal');

    // 7. Event Sequence Integrity & Tamper Detection
    const key = getAppEncryptionKey();
    const validMem1 = formatStructuredMemory({ analystId: analystA.id, eventType: 'CREATED', sequenceNumber: 1, payload: { predictionId: 'p1', market: '1X2', selection: 'A' }, key });
    const validMem2 = formatStructuredMemory({ analystId: analystA.id, eventType: 'SETTLED', sequenceNumber: 2, payload: { predictionId: 'p1', outcome: 'WON' }, key });

    // Normal replay
    const normalReplay = reconstructFromWalrusMemories([validMem1, validMem2], analystA.id, key);
    assert(normalReplay.success === true, 'Reconstruction from valid memories succeeds');
    assert(normalReplay.validEventsCount === 2, 'Valid events count is 2');
    assert(normalReplay.sequenceGapsDetected.length === 0, 'No sequence gaps detected in contiguous stream');

    // Sequence gap detection: skip sequence 2 (provide 1 and 3)
    const validMem3 = formatStructuredMemory({ analystId: analystA.id, eventType: 'CREATED', sequenceNumber: 3, payload: { predictionId: 'p2', market: 'BTTS', selection: 'Yes' }, key });
    const gapReplay = reconstructFromWalrusMemories([validMem1, validMem3], analystA.id, key);
    assert(gapReplay.sequenceGapsDetected.includes(2), 'Missing event sequence detected (gap at sequence 2)');

    // Ciphertext Tamper Detection
    const tamperedMem = validMem1.replace(/\[enc:([^:]+):([^:]+):([a-f0-9]{6})/, '[enc:$1:$2:abcdef');
    const tamperedReplay = reconstructFromWalrusMemories([tamperedMem], analystA.id, key);
    assert(tamperedReplay.tamperedEventsCount === 1, 'Corrupted ciphertext auth tag rejected (fails closed)');

    // 8. Deterministic Credibility Calculation Purely from Walrus
    // Simulate 6 settled picks: 4 WON, 2 LOST
    const credMemories: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const pid = `p-${i}`;
      credMemories.push(formatStructuredMemory({
        analystId: analystA.id,
        eventType: 'CREATED',
        sequenceNumber: i * 2 - 1,
        payload: { predictionId: pid, market: '1X2', selection: 'Team' },
        key,
      }));
      credMemories.push(formatStructuredMemory({
        analystId: analystA.id,
        eventType: 'SETTLED',
        sequenceNumber: i * 2,
        payload: { predictionId: pid, outcome: i <= 4 ? 'WON' : 'LOST', verification: 'API_VERIFIED' },
        key,
      }));
    }

    const fullReconstruction = reconstructFromWalrusMemories(credMemories, analystA.id, key);
    assert(fullReconstruction.validEventsCount === 12, 'Processed 12 valid memory events');
    assert(fullReconstruction.credibility.settledCount === 6, 'Reconstructed exactly 6 settled predictions');
    assert(fullReconstruction.credibility.wonCount === 4, 'Reconstructed 4 wins');
    assert(fullReconstruction.credibility.lostCount === 2, 'Reconstructed 2 losses');
    assert(Math.round(fullReconstruction.credibility.winRate * 10) / 10 === 66.7, 'Deterministic win rate is 66.7%');
    assert(fullReconstruction.credibility.ratingTier === 'Good', 'Rating computed as Good (>= 65%)');
    assert(fullReconstruction.credibility.historyBadge === 'Limited', 'History badge is Limited (6-19 settled)');

    // 9. User Isolation in Walrus Reconstruction
    const userBAnalyst = await createAnalyst(userB, 'Jamie Redknapp');
    const userBMem = formatStructuredMemory({
      analystId: userBAnalyst.id,
      eventType: 'CREATED',
      sequenceNumber: 1,
      payload: { predictionId: 'user-b-p1', market: '1X2', selection: 'Spurs' },
      key,
    });

    const userAReplay = reconstructFromWalrusMemories([validMem1, validMem2, userBMem], analystA.id, key);
    assert(userAReplay.validEventsCount === 2, 'User A reconstruction excludes User B memories');
    assert(!userAReplay.reconstructedPredictions['user-b-p1'], 'User B prediction is not present in User A history');

  } finally {
    // Cleanup
    await query('DELETE FROM users WHERE id IN ($1, $2);', [userA, userB]);
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('phase3-remember-slice.test.ts')) {
  runPhase3RememberSliceIntegrationTests()
    .then(r => {
      console.log(`\nPhase 3 Remember Slice Tests: ${r.count - r.failures.length}/${r.count} passed.`);
      process.exit(r.passed ? 0 : 1);
    })
    .catch(err => {
      console.error('Phase 3 Integration Test Fatal Error:', err);
      process.exit(1);
    });
}
