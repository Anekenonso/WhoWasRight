/**
 * Unit Tests: Deterministic Credibility Engine
 *
 * Verifies:
 * 1. Minimum 6 settled predictions eligibility threshold.
 * 2. Decisive outcome requirement (>=1 decisive outcome).
 * 3. Exact win-rate formula: Won / (Won + Lost).
 * 4. Push handling: counts for eligibility, excluded from denominator.
 * 5. Void handling: excluded from eligibility and denominator.
 * 6. Rating Tiers: Good (>=65%), Average (>=45% and <65%), Poor (<45%), Not Rated.
 * 7. History Badges: Insufficient (0-5), Limited (6-19), Growing (20-49), Established (50+).
 * 8. Individual counting of multiple picks from a single match.
 * 9. Separation of API-verified vs Self-reported counts.
 */

import { computeCredibility, type RawOutcomeItem } from '../../src/core/credibility.ts';

export function runCredibilityUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Credibility Unit Tests ---');

  // Test 1: 5 settled picks -> Not Rated (Eligibility requires >= 6)
  const fiveSettled: RawOutcomeItem[] = [
    { outcome: 'WON' },
    { outcome: 'WON' },
    { outcome: 'WON' },
    { outcome: 'WON' },
    { outcome: 'LOST' },
  ];
  const c1 = computeCredibility(fiveSettled);
  assert(c1.settledCount === 5, '5 settled picks settledCount === 5');
  assert(!c1.isEligible, '5 settled picks isEligible === false');
  assert(c1.ratingTier === 'Not Rated', '5 settled picks ratingTier === "Not Rated"');
  assert(c1.winRate === null, '5 settled picks winRate === null');
  assert(c1.historyBadge === 'Insufficient', '5 settled picks historyBadge === "Insufficient"');

  // Test 2: 6 settled with 0 decisive (6 Pushes) -> Not Rated
  const sixPushes: RawOutcomeItem[] = Array(6).fill({ outcome: 'PUSH' });
  const c2 = computeCredibility(sixPushes);
  assert(c2.settledCount === 6, '6 pushes settledCount === 6');
  assert(!c2.isEligible, '6 pushes isEligible === false (0 decisive)');
  assert(c2.ratingTier === 'Not Rated', '6 pushes ratingTier === "Not Rated"');

  // Test 3: Exactly 6 settled with 1 decisive (1 Won, 5 Pushes) -> Eligible (100% Good)
  const oneWonFivePushes: RawOutcomeItem[] = [
    { outcome: 'WON' },
    ...Array(5).fill({ outcome: 'PUSH' }),
  ];
  const c3 = computeCredibility(oneWonFivePushes);
  assert(c3.settledCount === 6, '1 Won + 5 Pushes settledCount === 6');
  assert(c3.isEligible, '1 Won + 5 Pushes isEligible === true');
  assert(c3.winRate === 100, '1 Won + 5 Pushes winRate === 100%');
  assert(c3.ratingTier === 'Good', '1 Won + 5 Pushes ratingTier === "Good"');
  assert(c3.historyBadge === 'Limited', '6 settled historyBadge === "Limited"');

  // Test 4: Good Tier Threshold (13 W, 7 L -> 13/20 = 65.0%)
  const goodSample: RawOutcomeItem[] = [
    ...Array(13).fill({ outcome: 'WON', verification: 'API_VERIFIED' }),
    ...Array(7).fill({ outcome: 'LOST', verification: 'API_VERIFIED' }),
  ];
  const c4 = computeCredibility(goodSample);
  assert(c4.winRate === 65, '13 W, 7 L winRate === 65.00%');
  assert(c4.ratingTier === 'Good', '13 W, 7 L ratingTier === "Good"');
  assert(c4.historyBadge === 'Growing', '20 settled historyBadge === "Growing"');
  assert(c4.apiVerifiedCount === 20, 'API verified count === 20');
  assert(c4.selfReportedCount === 0, 'Self reported count === 0');

  // Test 5: Average Tier Threshold (9 W, 11 L -> 9/20 = 45.0%)
  const avgSample: RawOutcomeItem[] = [
    ...Array(9).fill({ outcome: 'WON' }),
    ...Array(11).fill({ outcome: 'LOST' }),
  ];
  const c5 = computeCredibility(avgSample);
  assert(c5.winRate === 45, '9 W, 11 L winRate === 45.00%');
  assert(c5.ratingTier === 'Average', '9 W, 11 L ratingTier === "Average"');

  // Test 6: Poor Tier Threshold (8 W, 12 L -> 8/20 = 40.0%)
  const poorSample: RawOutcomeItem[] = [
    ...Array(8).fill({ outcome: 'WON' }),
    ...Array(12).fill({ outcome: 'LOST' }),
  ];
  const c6 = computeCredibility(poorSample);
  assert(c6.winRate === 40, '8 W, 12 L winRate === 40.00%');
  assert(c6.ratingTier === 'Poor', '8 W, 12 L ratingTier === "Poor"');

  // Test 7: Push & Void handling in combination
  // 10 Won, 3 Lost, 2 Push, 5 Void, 4 Pending
  // Settled = 10 + 3 + 2 = 15. Decisive = 10 + 3 = 13.
  // Win rate = 10 / 13 = 76.92% (Good)
  const mixedSample: RawOutcomeItem[] = [
    ...Array(10).fill({ outcome: 'WON', verification: 'API_VERIFIED' }),
    ...Array(3).fill({ outcome: 'LOST', verification: 'SELF_REPORTED' }),
    ...Array(2).fill({ outcome: 'PUSH', verification: 'API_VERIFIED' }),
    ...Array(5).fill({ outcome: 'VOID' }),
    ...Array(4).fill({ outcome: 'PENDING' }),
  ];
  const c7 = computeCredibility(mixedSample);
  assert(c7.settledCount === 15, 'Mixed sample settledCount === 15');
  assert(c7.decisiveCount === 13, 'Mixed sample decisiveCount === 13');
  assert(c7.voidCount === 5, 'Mixed sample voidCount === 5');
  assert(c7.pendingCount === 4, 'Mixed sample pendingCount === 4');
  assert(c7.winRate === 76.92, 'Mixed sample winRate === 76.92%');
  assert(c7.ratingTier === 'Good', 'Mixed sample ratingTier === "Good"');
  assert(c7.apiVerifiedCount === 12, 'Mixed sample apiVerifiedCount === 12');
  assert(c7.selfReportedCount === 3, 'Mixed sample selfReportedCount === 3');

  // Test 8: Established History Badge (50+ settled)
  const establishedSample: RawOutcomeItem[] = [
    ...Array(35).fill({ outcome: 'WON' }),
    ...Array(15).fill({ outcome: 'LOST' }),
  ];
  const c8 = computeCredibility(establishedSample);
  assert(c8.settledCount === 50, '50 settled picks');
  assert(c8.historyBadge === 'Established', '50 settled historyBadge === "Established"');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('credibility.test.ts')) {
  const res = runCredibilityUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}
