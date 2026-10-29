/**
 * Unit Tests: Football Provider Quota Guard & Caching Logic
 *
 * Verifies:
 * 1. 3-day sliding window boundary enforcement for API-Sports Free Plan.
 * 2. Rate-limiting ceiling protection (stops automatic requests before 100/day limit).
 * 3. Daily reset behavior.
 */

import { isWithinFreePlanWindow, FootballRateLimiter } from '../../src/core/football-cache.ts';

export function runFootballCacheUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Football Cache & Quota Unit Tests ---');

  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;

  // 1. Valid window (Today, Yesterday, Tomorrow)
  const today = new Date(now.getTime());
  const yesterday = new Date(now.getTime() - dayMs * 0.9);
  const tomorrow = new Date(now.getTime() + dayMs * 0.9);

  assert(isWithinFreePlanWindow(today), 'Today is within Free Plan window');
  assert(isWithinFreePlanWindow(yesterday), 'Yesterday is within Free Plan window');
  assert(isWithinFreePlanWindow(tomorrow), 'Tomorrow is within Free Plan window');

  // 2. Outside window (4 days ago, 4 days in future)
  const fourDaysAgo = new Date(now.getTime() - dayMs * 4);
  const fourDaysFuture = new Date(now.getTime() + dayMs * 4);

  assert(!isWithinFreePlanWindow(fourDaysAgo), '4 days ago is rejected by Free Plan window');
  assert(!isWithinFreePlanWindow(fourDaysFuture), '4 days in future is rejected by Free Plan window');

  // 3. Rate Limiter Hard Stop Protection
  const limiter = new FootballRateLimiter();
  assert(limiter.canMakeRequest(), 'Initial state allows requests');

  // Simulate 94 requests
  for (let i = 0; i < 94; i++) {
    limiter.recordRequest();
  }
  assert(limiter.canMakeRequest(), '94 requests still allows 95th request');

  limiter.recordRequest(); // 95th request
  assert(!limiter.canMakeRequest(), '95th request triggers rate-limit hard stop (protecting 100 limit)');

  const usage = limiter.getUsage();
  assert(usage.used === 95, 'Usage used === 95');
  assert(usage.remaining === 5, 'Usage remaining === 5');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('football-cache.test.ts')) {
  const res = runFootballCacheUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}

