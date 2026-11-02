/**
 * Walrus V2 Lifecycle End-to-End Verification Test
 *
 * Exercises the complete decentralized data lifecycle:
 * CREATE -> OUTBOX -> WALRUS WRITE -> WALRUS RECALL -> HISTORY RECONSTRUCTION -> CREDIBILITY VALIDATION
 *
 * Invariants Tested:
 * 1. Monotonic atomic sequence allocation (Migration 006).
 * 2. Format version 2 structured envelopes with AES-256-GCM encryption.
 * 3. Outbox queueing and worker receipt processing.
 * 4. Prediction lifecycle: CREATED -> SETTLED -> CORRECTED.
 * 5. Lifecycle extensions: ANALYST_MERGED and SNAPSHOT.
 * 6. Genuinely independent recall (zero database fallback).
 * 7. Exact mathematical credibility scorecard reconstruction.
 * 8. Fail-closed tamper detection (altered ciphertext or auth tag).
 * 9. Fail-closed sequence gap detection.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  formatStructuredMemory,
  parseStructuredMemory,
  encryptRecord,
  decryptRecord,
} from '../../src/core/crypto.ts';
import {
  reconstructFromWalrusMemories,
  type ReconstructionReport,
} from '../../src/core/walrus-reconstruction.ts';

export interface TestLifecycleResult {
  passed: boolean;
  totalAssertions: number;
  failures: string[];
  report: {
    environment: string;
    userId: string;
    analystId: string;
    eventsGenerated: number;
    receiptsConfirmed: number;
    recalledMemoriesCount: number;
    expectedCredibility: {
      settledCount: number;
      wonCount: number;
      lostCount: number;
      winRate: number;
      ratingTier: string;
    };
    reconstructedCredibility: {
      settledCount: number;
      wonCount: number;
      lostCount: number;
      winRate: number;
      ratingTier: string;
    };
    tamperDetected: boolean;
    sequenceGapDetected: boolean;
  };
}

export async function runWalrusV2LifecycleTest(): Promise<TestLifecycleResult> {
  const failures: string[] = [];
  let totalAssertions = 0;

  function assert(condition: boolean, testName: string) {
    totalAssertions++;
    if (!condition) {
      failures.push(testName);
      console.error(`  [FAIL] ${testName}`);
    } else {
      console.log(`  [PASS] ${testName}`);
    }
  }

  console.log('\n============================================================');
  console.log('WALRUS V2 END-TO-END LIFECYCLE & RECONSTRUCTION VERIFICATION');
  console.log('============================================================');

  const encryptionKey = randomBytes(32);
  const userId = randomUUID();
  const analystId = randomUUID();
  const secondaryAnalystId = randomUUID();

  // Simulated Walrus Storage Node / Decentralized Blob Store
  interface WalrusBlobRecord {
    blobId: string;
    jobId: string;
    content: string;
    storedAt: string;
    sequenceNumber: number;
  }
  const walrusStorageCluster: Map<string, WalrusBlobRecord> = new Map();

  // Simulated Transactional Outbox (PostgreSQL memory_outbox + user_event_sequences)
  interface OutboxRecord {
    id: string;
    userId: string;
    eventKey: string;
    payload: string;
    formatVersion: number;
    sequenceNumber: number;
    status: 'PENDING' | 'IN_FLIGHT' | 'CONFIRMED' | 'FAILED';
    walrusJobId?: string;
  }
  const outboxTable: OutboxRecord[] = [];
  let userNextSequence = 1;

  // Transactional sequence allocator
  function allocateSequence(): number {
    return userNextSequence++;
  }

  // Transactional outbox insert
  function insertOutbox(eventKey: string, payload: string, seq: number): OutboxRecord {
    const record: OutboxRecord = {
      id: randomUUID(),
      userId,
      eventKey,
      payload,
      formatVersion: 2,
      sequenceNumber: seq,
      status: 'PENDING',
    };
    outboxTable.push(record);
    return record;
  }

  // Simulated Outbox Worker: processes PENDING items, sends to Walrus, writes receipts
  function processOutboxWorker(): { processed: number; confirmed: number } {
    let count = 0;
    for (const item of outboxTable) {
      if (item.status === 'PENDING') {
        item.status = 'IN_FLIGHT';
        const jobId = `job-${randomUUID()}`;
        const blobId = `blob-${randomBytes(16).toString('hex')}`;
        
        // Write to Walrus storage
        walrusStorageCluster.set(blobId, {
          blobId,
          jobId,
          content: item.payload,
          storedAt: new Date().toISOString(),
          sequenceNumber: item.sequenceNumber,
        });

        // Atomic transition to CONFIRMED
        item.status = 'CONFIRMED';
        item.walrusJobId = jobId;
        count++;
      }
    }
    return { processed: count, confirmed: count };
  }

  console.log('\n--- Phase 1: Prediction Creation (Sequence 1..7) ---');
  // Create 7 predictions: pred-1 to pred-7
  const predictionIds: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const predId = `pred-${i}-${randomBytes(4).toString('hex')}`;
    predictionIds.push(predId);
    const seq = allocateSequence();
    const payload = formatStructuredMemory({
      analystId,
      eventType: 'CREATED',
      sequenceNumber: seq,
      payload: {
        predictionId: predId,
        eventId: `event-match-${i}`,
        market: '1X2',
        selection: 'Arsenal',
        createdAt: new Date().toISOString(),
      },
      key: encryptionKey,
    });
    insertOutbox(`pred-create-${predId}`, payload, seq);
  }

  assert(outboxTable.length === 7, '7 CREATED events entered outbox');
  assert(outboxTable.every(o => o.formatVersion === 2), 'All outbox records enforce format_version === 2');
  assert(outboxTable[6].sequenceNumber === 7, 'Monotonic sequence numbering verified (seq 1 to 7)');

  // Process outbox
  const p1Out = processOutboxWorker();
  assert(p1Out.confirmed === 7, 'Outbox worker processed and confirmed all 7 CREATED records');
  assert(walrusStorageCluster.size === 7, 'Walrus decentralized storage received 7 blobs');

  console.log('\n--- Phase 2: Match Settlements (Sequence 8..13) ---');
  // Settle predictions 1..6:
  // pred-1: WON
  // pred-2: WON
  // pred-3: WON
  // pred-4: WON
  // pred-5: LOST
  // pred-6: LOST
  // pred-7: remains PENDING (unsettled)
  const settlementOutcomes: Array<'WON' | 'LOST'> = ['WON', 'WON', 'WON', 'WON', 'LOST', 'LOST'];
  for (let i = 0; i < 6; i++) {
    const predId = predictionIds[i];
    const outcome = settlementOutcomes[i];
    const seq = allocateSequence();
    const payload = formatStructuredMemory({
      analystId,
      eventType: 'SETTLED',
      sequenceNumber: seq,
      payload: {
        predictionId: predId,
        outcome,
        source: 'API_VERIFIED',
        settledAt: new Date().toISOString(),
        evidence: { fullTimeScore: '2-1' },
      },
      key: encryptionKey,
    });
    insertOutbox(`pred-settle-${predId}`, payload, seq);
  }

  assert(outboxTable.length === 13, '6 SETTLED events entered outbox (13 total)');
  const p2Out = processOutboxWorker();
  assert(p2Out.confirmed === 6, 'Outbox worker confirmed all 6 SETTLED records');
  assert(walrusStorageCluster.size === 13, 'Walrus storage cluster contains 13 blobs');

  console.log('\n--- Phase 3: Result Correction (Sequence 14) ---');
  // Correct prediction #1 from WON to LOST (self-reported human correction or referee VAR overturn)
  const corrPredId = predictionIds[0];
  const corrSeq = allocateSequence();
  const corrPayload = formatStructuredMemory({
    analystId,
    eventType: 'CORRECTED',
    sequenceNumber: corrSeq,
    payload: {
      predictionId: corrPredId,
      outcome: 'LOST',
      source: 'HUMAN_AUDIT_CORRECTION',
      correctedAt: new Date().toISOString(),
      reason: 'VAR overturned goal in 94th minute',
    },
    key: encryptionKey,
  });
  insertOutbox(`pred-correct-${corrPredId}`, corrPayload, corrSeq);

  assert(outboxTable.length === 14, 'CORRECTED event entered outbox (14 total)');
  processOutboxWorker();
  assert(walrusStorageCluster.size === 14, 'Walrus storage cluster confirmed 14 blobs');

  console.log('\n--- Phase 4: Analyst Merge & Snapshot (Sequence 15..16) ---');
  // Analyst Merge event
  const mergeSeq = allocateSequence();
  const mergePayload = formatStructuredMemory({
    analystId,
    eventType: 'ANALYST_MERGED',
    sequenceNumber: mergeSeq,
    payload: {
      sourceAnalystId: secondaryAnalystId,
      targetAnalystId: analystId,
      action: 'MERGE',
      mergedAt: new Date().toISOString(),
    },
    key: encryptionKey,
  });
  insertOutbox(`merge-${secondaryAnalystId}`, mergePayload, mergeSeq);

  // Snapshot event
  const snapSeq = allocateSequence();
  const snapPayload = formatStructuredMemory({
    analystId,
    eventType: 'SNAPSHOT',
    sequenceNumber: snapSeq,
    payload: {
      analystId,
      epoch: 1,
      baselineTotalPicks: 7,
      baselineSettledCount: 6,
      baselineWonCount: 3,
      baselineLostCount: 3,
      snapshotTimestamp: new Date().toISOString(),
    },
    key: encryptionKey,
  });
  insertOutbox(`snapshot-${analystId}`, snapPayload, snapSeq);

  processOutboxWorker();
  assert(walrusStorageCluster.size === 16, 'Full lifecycle of 16 events confirmed in Walrus');

  console.log('\n--- Phase 5: Genuinely Independent Recall (No DB Fallback) ---');
  // Retrieve ALL raw memory strings directly from the simulated Walrus cluster
  // Notice: We completely sever connection to outboxTable, database, and prediction tables.
  const recalledMemories: string[] = Array.from(walrusStorageCluster.values())
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
    .map(b => b.content);

  assert(recalledMemories.length === 16, 'Retrieved exactly 16 raw memory envelopes from Walrus storage');
  assert(recalledMemories.every(m => m.startsWith('[WWR:v1]')), 'All retrieved memories verified with authentic [WWR:v1] envelope prefix');

  console.log('\n--- Phase 6: Deterministic Historical Reconstruction ---');
  // Reconstruct purely from the recalled string array and the symmetric 256-bit encryption key
  const report: ReconstructionReport = reconstructFromWalrusMemories(
    recalledMemories,
    analystId,
    encryptionKey
  );

  assert(report.success === true, 'Reconstruction succeeded with 100% integrity');
  assert(report.totalEventsProcessed === 16, 'Reconstruction processed all 16 chronological events');
  assert(report.tamperedEventsCount === 0, 'Zero tampered events detected');
  assert(report.sequenceGapsDetected.length === 0, 'Zero sequence gaps detected');

  // Verify prediction states
  const reconstructedPreds = report.reconstructedPredictions;
  assert(reconstructedPreds[corrPredId].outcome === 'LOST', 'Prediction 1 correctly reflects final CORRECTED state: LOST');
  assert(reconstructedPreds[predictionIds[1]].outcome === 'WON', 'Prediction 2 reflects SETTLED state: WON');
  assert(reconstructedPreds[predictionIds[4]].outcome === 'LOST', 'Prediction 5 reflects SETTLED state: LOST');
  assert(reconstructedPreds[predictionIds[6]].outcome === 'PENDING', 'Prediction 7 remains PENDING');

  // Verify Credibility Scorecard Mathematics
  // Out of 6 settled picks:
  // - Prediction 1: Was WON, then CORRECTED to LOST.
  // - Predictions 2, 3, 4: WON (3 won)
  // - Predictions 5, 6: LOST (2 lost) + Prediction 1 (1 lost) = 3 lost
  // Win rate = 3 / (3 + 3) = 50.00%
  // 50.00% with >= 6 decisive picks -> Rating Tier: "Average"
  const cred = report.credibility;
  assert(cred.settledCount === 6, 'Reconstructed settledCount === 6');
  assert(cred.wonCount === 3, 'Reconstructed wonCount === 3');
  assert(cred.lostCount === 3, 'Reconstructed lostCount === 3');
  assert(cred.winRate === 50, 'Reconstructed winRate === 50.00%');
  assert(cred.ratingTier === 'Average', 'Reconstructed ratingTier === "Average"');

  console.log('\n--- Phase 7: Negative Tamper Verification (Fail-Closed) ---');
  // Corrupt a single byte of ciphertext in memory #3
  const tamperedMemories = [...recalledMemories];
  const origMem = tamperedMemories[2];
  const lastBracket = origMem.lastIndexOf(']');
  tamperedMemories[2] = origMem.slice(0, lastBracket - 4) + 'abcd' + origMem.slice(lastBracket);
  const tamperedReport = reconstructFromWalrusMemories(tamperedMemories, analystId, encryptionKey);

  assert(tamperedReport.success === false, 'Tampered ciphertext causes reconstruction report.success === false (Fails closed)');
  assert(tamperedReport.tamperedEventsCount === 1, 'Tampered event detected and counted');

  console.log('\n--- Phase 8: Negative Sequence Gap Verification (Fail-Closed) ---');
  // Drop sequence #8 (missing event in sequence chain)
  const gappedMemories = recalledMemories.filter((_, idx) => idx !== 7);
  const gappedReport = reconstructFromWalrusMemories(gappedMemories, analystId, encryptionKey);

  assert(gappedReport.success === false, 'Missing sequence number causes report.success === false (Fails closed)');
  assert(gappedReport.sequenceGapsDetected.length > 0, 'Sequence gap detected and logged');

  const passed = failures.length === 0;
  console.log('\n============================================================');
  console.log(`LIFECYCLE TEST RESULT: ${passed ? 'ALL INVARIANTS PASSED' : 'FAILED'}`);
  console.log(`Total Assertions Checked: ${totalAssertions}`);
  console.log('============================================================\n');

  return {
    passed,
    totalAssertions,
    failures,
    report: {
      environment: 'Isolated V2 Lifecycle Test (Node.js 22+ TS Native)',
      userId,
      analystId,
      eventsGenerated: 16,
      receiptsConfirmed: 16,
      recalledMemoriesCount: 16,
      expectedCredibility: {
        settledCount: 6,
        wonCount: 3,
        lostCount: 3,
        winRate: 50,
        ratingTier: 'Average',
      },
      reconstructedCredibility: {
        settledCount: cred.settledCount,
        wonCount: cred.wonCount,
        lostCount: cred.lostCount,
        winRate: cred.winRate,
        ratingTier: cred.ratingTier,
      },
      tamperDetected: tamperedReport.tamperedEventsCount > 0,
      sequenceGapDetected: gappedReport.sequenceGapsDetected.length > 0,
    },
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('walrus-v2-lifecycle.test.ts')) {
  runWalrusV2LifecycleTest().then(res => {
    process.exitCode = res.passed ? 0 : 1;
  });
}
