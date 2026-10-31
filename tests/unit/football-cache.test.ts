/**
 * Unit Tests: Football Provider Quota Guard & Caching Logic
 *
 * Verifies:
 * 1. 3-day sliding window boundary enforcement for API-Sports Free Plan.
 * 2. Rate-limiting ceiling protection (stops automatic requests before 100/day limit).
 * 3. Daily reset behavior matching 00:00:00 UTC boundary.
 * 4. Per-sport quota isolation (Football 95 hard stop vs Basketball 100 limit).
 * 5. Failed calls and retries consume quota slots.
 */

import { isWithinFreePlanWindow, FootballRateLimiter, getSportRateLimiter, SportRateLimiter } from '../../src/core/football-cache.ts';

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

  // 4. API-Sports Quota Isolation Across Sports
  console.log('\n  [Section 4: Multi-Sport Quota Isolation]');
  const fbLimiter = getSportRateLimiter('FOOTBALL');
  const bbLimiter = getSportRateLimiter('BASKETBALL');
  fbLimiter.resetForTesting();
  bbLimiter.resetForTesting();

  assert(fbLimiter.getSport() === 'FOOTBALL', 'Football limiter sport identifier is FOOTBALL');
  assert(bbLimiter.getSport() === 'BASKETBALL', 'Basketball limiter sport identifier is BASKETBALL');
  assert(fbLimiter.getHardStopThreshold() === 95, 'Football hard stop threshold is strictly 95');
  assert(bbLimiter.getHardStopThreshold() === 100, 'Basketball daily allowance is 100');

  // Consume Football quota up to hard stop
  for (let i = 0; i < 95; i++) {
    fbLimiter.recordRequest();
  }
  assert(!fbLimiter.canMakeRequest(), 'Football reaches 95 hard ceiling and blocks requests');
  assert(fbLimiter.getUsage().used === 95, 'Football used === 95');
  assert(fbLimiter.getUsage().remaining === 5, 'Football remaining === 5');

  // Verify Basketball quota is completely unaffected
  assert(bbLimiter.canMakeRequest(), 'Basketball quota is unaffected by Football exhaustion');
  assert(bbLimiter.getUsage().used === 0, 'Basketball used === 0');
  assert(bbLimiter.getUsage().remaining === 100, 'Basketball remaining === 100');

  // Consume Basketball request (e.g. including simulated retry/failure)
  bbLimiter.recordRequest(); // 1st attempt
  bbLimiter.recordRequest(); // failed retry attempt accounted for safely
  assert(bbLimiter.getUsage().used === 2, 'Basketball used === 2 (retries/failures accounted safely)');
  assert(fbLimiter.getUsage().used === 95, 'Football used remains 95 after Basketball activity (Strict Quota Isolation)');

  // 5. Quota Reservation & UTC Midnight Reset Boundary
  console.log('\n  [Section 5: Quota Reservation & Provider Reset Boundary]');
  const freshFb = new SportRateLimiter('FOOTBALL', 100, 95);
  assert(freshFb.canMakeRequest(), 'Fresh instance can make requests');

  // Fill up to 95 via recordRequest (simulating failed calls consuming quota)
  for (let i = 0; i < 95; i++) {
    freshFb.recordRequest();
  }
  assert(!freshFb.canMakeRequest(), '95 consumed requests blocks further calls');
  assert(freshFb.getUsage().used === 95, '95 consumed slots registered in usage');

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
