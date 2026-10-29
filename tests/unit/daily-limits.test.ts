/**
 * Unit Tests: Daily Logging Limits (Advisory Soft Limit)
 *
 * Verifies approved behavior:
 * 1. Predictions 1–15: No warning (NORMAL, canSave=true).
 * 2. Beginning with 16th prediction: Display gentle warning (WARNING, canSave=true).
 * 3. At 25+ predictions: Continue allowing saves normally (ADVISORY, canSave=true).
 * 4. Neutral helpful wording: "You've logged a lot of predictions today. Everything is still being saved normally."
 * 5. Removes any language suggesting poor-quality predictions.
 * 6. Explicitly tests 15th, 16th, 25th, and 26th submissions.
 * 7. Invariant: canSave is ALWAYS true across all tiers (NO hard limits).
 */

import { evaluateDailyLimit } from '../../src/core/daily-limits.ts';

export function runDailyLimitsUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Daily Limits Unit Tests ---');

  const EXPECTED_NEUTRAL_MSG = "You've logged a lot of predictions today. Everything is still being saved normally.";

  // 1. Normal Tier (Predictions 1-15)
  const l0 = evaluateDailyLimit(0);
  assert(l0.status === 'NORMAL', 'Count 0 is NORMAL');
  assert(l0.canSave === true, 'Count 0 canSave === true');
  assert(!l0.warningMessage, 'Count 0 has no warning message');

  const l14 = evaluateDailyLimit(14);
  assert(l14.status === 'NORMAL', 'Count 14 is NORMAL');
  assert(l14.canSave === true, 'Count 14 canSave === true');

  // Explicit test: 15th submission (Predictions 1-15: No warning)
  const l15 = evaluateDailyLimit(15);
  assert(l15.status === 'NORMAL', '15th submission is NORMAL (no warning)');
  assert(l15.canSave === true, '15th submission canSave === true');
  assert(!l15.warningMessage, '15th submission has no warning message');

  // 2. Warning Tier (Beginning with 16th prediction)
  // Explicit test: 16th submission
  const l16 = evaluateDailyLimit(16);
  assert(l16.status === 'WARNING', '16th submission triggers WARNING');
  assert(l16.canSave === true, '16th submission canSave === true (NO hard block)');
  assert(l16.warningMessage === EXPECTED_NEUTRAL_MSG, '16th submission uses approved neutral helpful wording');
  assert(!l16.warningMessage?.includes('Take a breather'), '16th submission contains NO judgmental language');

  const l24 = evaluateDailyLimit(24);
  assert(l24.status === 'WARNING', 'Count 24 is WARNING');
  assert(l24.canSave === true, 'Count 24 canSave === true');
  assert(l24.warningMessage === EXPECTED_NEUTRAL_MSG, 'Count 24 uses neutral helpful wording');

  // 3. Advisory Tier (25+ predictions)
  // Explicit test: 25th submission
  const l25 = evaluateDailyLimit(25);
  assert(l25.status === 'ADVISORY', '25th submission is ADVISORY');
  assert(l25.canSave === true, '25th submission canSave === true (NO hard block)');
  assert(l25.warningMessage === EXPECTED_NEUTRAL_MSG, '25th submission uses neutral helpful wording');
  assert(!l25.warningMessage?.includes('dilute'), '25th submission contains NO negative quality implication');

  // Explicit test: 26th submission
  const l26 = evaluateDailyLimit(26);
  assert(l26.status === 'ADVISORY', '26th submission is ADVISORY');
  assert(l26.canSave === true, '26th submission canSave === true (allows saves normally)');
  assert(l26.warningMessage === EXPECTED_NEUTRAL_MSG, '26th submission uses neutral helpful wording');

  const l50 = evaluateDailyLimit(50);
  assert(l50.status === 'ADVISORY', 'Count 50 is ADVISORY');
  assert(l50.canSave === true, 'Count 50 canSave === true');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('daily-limits.test.ts')) {
  const res = runDailyLimitsUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}

