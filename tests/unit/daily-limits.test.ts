/**
 * Unit Tests: Daily Logging Limits (Advisory Soft Limit)
 *
 * Verifies:
 * 1. Count 0-14 -> NORMAL (canSave=true, no warning).
 * 2. Count 15-24 -> WARNING (canSave=true, gentle warning).
 * 3. Count 25+ -> ADVISORY (canSave=true, high activity advisory).
 * 4. Invariant: canSave is ALWAYS true across all tiers (no hard block).
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

  // 1. Normal Tier (0-14)
  const l0 = evaluateDailyLimit(0);
  assert(l0.status === 'NORMAL', 'Count 0 is NORMAL');
  assert(l0.canSave === true, 'Count 0 canSave === true');
  assert(!l0.warningMessage, 'Count 0 has no warning message');

  const l14 = evaluateDailyLimit(14);
  assert(l14.status === 'NORMAL', 'Count 14 is NORMAL');
  assert(l14.canSave === true, 'Count 14 canSave === true');

  // 2. Warning Tier (15-24)
  const l15 = evaluateDailyLimit(15);
  assert(l15.status === 'WARNING', 'Count 15 triggers WARNING');
  assert(l15.canSave === true, 'Count 15 canSave === true (NO hard block)');
  assert(l15.warningMessage?.includes('Take a breather'), 'Count 15 includes gentle warning');

  const l24 = evaluateDailyLimit(24);
  assert(l24.status === 'WARNING', 'Count 24 is WARNING');
  assert(l24.canSave === true, 'Count 24 canSave === true');

  // 3. Advisory Tier (25+)
  const l25 = evaluateDailyLimit(25);
  assert(l25.status === 'ADVISORY', 'Count 25 triggers ADVISORY');
  assert(l25.canSave === true, 'Count 25 canSave === true (NO hard block)');
  assert(l25.warningMessage?.includes('High activity'), 'Count 25 includes advisory message');

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

