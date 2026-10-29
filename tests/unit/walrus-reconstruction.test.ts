/**
 * Unit Tests: Walrus Historical Reconstruction Contract
 *
 * Verifies:
 * 1. Reconstruction purely from validated Walrus Memory event envelopes.
 * 2. Deterministic replay of lifecycle: CREATED -> SETTLED -> CORRECTED.
 * 3. AES-256-GCM authentication failure detection (tampered ciphertext caught).
 * 4. Sequence number gap detection.
 * 5. Reconstructed scorecard equivalence with expected mathematical rules.
 */

import { randomBytes } from 'node:crypto';
import { formatStructuredMemory } from '../../src/core/crypto.ts';
import { reconstructFromWalrusMemories } from '../../src/core/walrus-reconstruction.ts';

export function runWalrusReconstructionUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Walrus Historical Reconstruction Unit Tests ---');

  const testKey = randomBytes(32);
  const analystId = '0192e21b-6893-7850-84cf-eb95eb28c7c2';

  // Scenario: 7 predictions created, 6 settled (4 Won, 2 Lost), 1 Pending.
  // Then Prediction #1 is CORRECTED from Won to Lost.
  // Final state: 3 Won, 3 Lost (50.0% -> Average Tier).
  const rawMemories: string[] = [];

  // Seq 1-7: CREATED
  for (let i = 1; i <= 7; i++) {
    rawMemories.push(
      formatStructuredMemory({
        analystId,
        eventType: 'CREATED',
        sequenceNumber: i,
        payload: {
          predictionId: `pred-${i}`,
          eventId: `event-${i}`,
          market: '1X2',
          selection: 'Home',
          createdAt: new Date().toISOString(),
        },
        key: testKey,
      })
    );
  }

  // Seq 8-13: SETTLED (pred-1 to pred-4 = WON, pred-5 to pred-6 = LOST)
  for (let i = 1; i <= 4; i++) {
    rawMemories.push(
      formatStructuredMemory({
        analystId,
        eventType: 'SETTLED',
        sequenceNumber: 7 + i,
        payload: {
          predictionId: `pred-${i}`,
          newOutcome: 'WON',
          verification: 'API_VERIFIED',
          settledAt: new Date().toISOString(),
        },
        key: testKey,
      })
    );
  }
  for (let i = 5; i <= 6; i++) {
    rawMemories.push(
      formatStructuredMemory({
        analystId,
        eventType: 'SETTLED',
        sequenceNumber: 7 + i,
        payload: {
          predictionId: `pred-${i}`,
          newOutcome: 'LOST',
          verification: 'API_VERIFIED',
          settledAt: new Date().toISOString(),
        },
        key: testKey,
      })
    );
  }

  // Seq 14: CORRECTED (pred-1 changed from WON to LOST)
  rawMemories.push(
    formatStructuredMemory({
      analystId,
      eventType: 'CORRECTED',
      sequenceNumber: 14,
      payload: {
        predictionId: 'pred-1',
        newOutcome: 'LOST',
        verification: 'SELF_REPORTED',
        settledAt: new Date().toISOString(),
      },
      key: testKey,
    })
  );

  // Test 1: Full Valid Reconstruction
  const report = reconstructFromWalrusMemories(rawMemories, analystId, testKey);
  assert(report.success, 'Valid reconstruction report.success === true');
  assert(report.validEventsCount === 14, 'Processed all 14 chronological events');
  assert(report.tamperedEventsCount === 0, 'Zero tampered events detected');
  assert(report.sequenceGapsDetected.length === 0, 'Zero sequence gaps detected');

  // Verify state replay
  const p1 = report.reconstructedPredictions['pred-1'];
  assert(p1.outcome === 'LOST', 'pred-1 reflects final CORRECTED outcome: LOST');
  assert(p1.verification === 'SELF_REPORTED', 'pred-1 reflects CORRECTED verification: SELF_REPORTED');

  const p7 = report.reconstructedPredictions['pred-7'];
  assert(p7.outcome === 'PENDING', 'pred-7 remains PENDING');

  // Verify Reconstructed Credibility Scorecard
  // 3 Won (pred-2, pred-3, pred-4), 3 Lost (pred-1, pred-5, pred-6) => 3/6 = 50.0% (Average)
  const cred = report.credibility;
  assert(cred.settledCount === 6, 'Reconstructed settledCount === 6');
  assert(cred.wonCount === 3, 'Reconstructed wonCount === 3');
  assert(cred.lostCount === 3, 'Reconstructed lostCount === 3');
  assert(cred.winRate === 50, 'Reconstructed winRate === 50.00%');
  assert(cred.ratingTier === 'Average', 'Reconstructed ratingTier === "Average"');

  // Test 2: Tampered Ciphertext Detection (Fails Closed)
  const tamperedMemories = [...rawMemories];
  // Corrupt the ciphertext of event 14
  const original = rawMemories[13];
  const lastBracket = original.lastIndexOf(']');
  const tampered = original.slice(0, lastBracket - 4) + 'abcd' + original.slice(lastBracket);
  tamperedMemories[13] = tampered;
  const tamperedReport = reconstructFromWalrusMemories(tamperedMemories, analystId, testKey);
  assert(!tamperedReport.success, 'Tampered memory causes report.success === false');
  assert(tamperedReport.tamperedEventsCount === 1, 'Tampered event counted in report');

  // Test 3: Sequence Gap Detection (Missing event)
  const gappedMemories = rawMemories.filter((_, idx) => idx !== 4); // drop seq 5
  const gappedReport = reconstructFromWalrusMemories(gappedMemories, analystId, testKey);
  assert(!gappedReport.success, 'Sequence gap causes report.success === false');
  assert(gappedReport.sequenceGapsDetected.length > 0, 'Sequence gap detected in report');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('walrus-reconstruction.test.ts')) {
  const res = runWalrusReconstructionUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}

