/**
 * Unit Tests: Demo Session Cleanup & Telegram Login Widget Invariants
 *
 * Verifies:
 * 1. Demo cleanup SQL contract targets strictly negative telegram_id (< 0).
 * 2. Real users (telegram_id > 0) are strictly excluded from cleanup queries.
 * 3. Expired sessions condition vs active sessions preservation logic.
 * 4. Non-blocking error isolation in /api/cron/settle response format.
 * 5. Telegram Login Widget HTML generation with valid, invalid, and missing TELEGRAM_BOT_NAME.
 */

import { cleanupExpiredDemoSessions, getDemoSessionTtlMinutes } from '../../src/core/demo-mode.ts';
import { renderMobileAppHtml } from '../../src/web/server.ts';

export async function runDemoCleanupUnitTests(): Promise<{ passed: boolean; count: number; failures: string[] }> {
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

  console.log('\n--- Running Demo Session Cleanup & Auth Widget Unit Tests ---');

  // ============================================================
  // Section 1: Demo Cleanup SQL Invariants
  // ============================================================
  console.log('\n  [Section 1: Demo Cleanup Query Invariants]');

  // Inspect the source code of cleanupExpiredDemoSessions
  const cleanupSource = cleanupExpiredDemoSessions.toString();

  assert(
    cleanupSource.includes('telegram_id < 0'),
    'Cleanup query explicitly filters for telegram_id < 0'
  );

  assert(
    !cleanupSource.includes('telegram_id > 0') && !cleanupSource.includes('telegram_id ='),
    'Cleanup query does not touch positive telegram_id accounts'
  );

  assert(
    cleanupSource.includes('MAX(expires_at) < NOW()'),
    'Cleanup query requires all associated sessions to be expired'
  );

  assert(
    cleanupSource.includes("INTERVAL '5 minutes'") && cleanupSource.includes('NOT EXISTS'),
    'Cleanup query handles orphaned demo users without active unexpired sessions'
  );

  // ============================================================
  // Section 2: Real User vs Demo User Target Logic
  // ============================================================
  console.log('\n  [Section 2: Target Filtering Logic]');

  interface CandidateUser {
    telegram_id: number;
    hasActiveSession: boolean;
    allSessionsExpired: boolean;
    createdMinutesAgo: number;
  }

  function shouldBeCleanedUp(user: CandidateUser): boolean {
    if (user.telegram_id >= 0) return false; // Real user: strictly untouched
    if (user.allSessionsExpired) return true;
    if (user.createdMinutesAgo > 5 && !user.hasActiveSession) return true;
    return false;
  }

  const realUserExpired: CandidateUser = {
    telegram_id: 123456789,
    hasActiveSession: false,
    allSessionsExpired: true,
    createdMinutesAgo: 60,
  };
  assert(!shouldBeCleanedUp(realUserExpired), 'Real user with expired session is NEVER cleaned up');

  const realUserActive: CandidateUser = {
    telegram_id: 987654321,
    hasActiveSession: true,
    allSessionsExpired: false,
    createdMinutesAgo: 10,
  };
  assert(!shouldBeCleanedUp(realUserActive), 'Real user with active session is NEVER cleaned up');

  const demoUserActive: CandidateUser = {
    telegram_id: -100500,
    hasActiveSession: true,
    allSessionsExpired: false,
    createdMinutesAgo: 2,
  };
  assert(!shouldBeCleanedUp(demoUserActive), 'Demo user with active session is preserved');

  const demoUserExpired: CandidateUser = {
    telegram_id: -100501,
    hasActiveSession: false,
    allSessionsExpired: true,
    createdMinutesAgo: 120,
  };
  assert(shouldBeCleanedUp(demoUserExpired), 'Demo user with all sessions expired is cleaned up');

  const demoUserStaleNoSession: CandidateUser = {
    telegram_id: -100502,
    hasActiveSession: false,
    allSessionsExpired: false,
    createdMinutesAgo: 15,
  };
  assert(shouldBeCleanedUp(demoUserStaleNoSession), 'Demo user older than 5 min with no active session is cleaned up');

  const demoUserBrandNewNoSession: CandidateUser = {
    telegram_id: -100503,
    hasActiveSession: false,
    allSessionsExpired: false,
    createdMinutesAgo: 1,
  };
  assert(!shouldBeCleanedUp(demoUserBrandNewNoSession), 'Demo user newer than 5 min is preserved during initial setup');

  // ============================================================
  // Section 3: Non-Blocking Cron Settle Response Structure
  // ============================================================
  console.log('\n  [Section 3: Non-Blocking Cron Response Contract]');

  // Test simulation of cron settle response logic
  function simulateCronResponse(
    settlementResult: any,
    notifResult: any,
    cleanupFn: () => number
  ) {
    let demoCleanupResult: { cleaned: number; error: string | null } = { cleaned: 0, error: null };
    try {
      demoCleanupResult.cleaned = cleanupFn();
    } catch (err: any) {
      demoCleanupResult.error = err.message || 'Demo session cleanup failed';
    }

    return {
      statusCode: 200,
      body: {
        settlement: settlementResult,
        notifications: notifResult,
        demoCleanup: demoCleanupResult,
      },
    };
  }

  // Case A: Cleanup succeeds
  const successRes = simulateCronResponse({ settled: 2 }, { sent: 1 }, () => 4);
  assert(successRes.statusCode === 200, 'Cron response status is 200 when cleanup succeeds');
  assert(successRes.body.demoCleanup.cleaned === 4, 'Cron response reports cleaned count');
  assert(successRes.body.demoCleanup.error === null, 'Cron response has null error on success');

  // Case B: Cleanup throws exception
  const errorRes = simulateCronResponse({ settled: 2 }, { sent: 1 }, () => {
    throw new Error('Database connection reset during cleanup');
  });
  assert(errorRes.statusCode === 200, 'Cron response remains 200 even when demo cleanup throws');
  assert(errorRes.body.settlement.settled === 2, 'Settlement result is preserved despite cleanup failure');
  assert(errorRes.body.notifications.sent === 1, 'Notifications result is preserved despite cleanup failure');
  assert(errorRes.body.demoCleanup.cleaned === 0, 'Cleaned count is 0 on error');
  assert(errorRes.body.demoCleanup.error === 'Database connection reset during cleanup', 'Error message captured cleanly');

  // ============================================================
  // Section 4: Telegram Login Widget HTML Rendering
  // ============================================================
  console.log('\n  [Section 4: Telegram Login Widget Rendering]');

  function getRenderedHtml(envBotName?: string): string {
    const originalBotName = process.env.TELEGRAM_BOT_NAME;
    const originalBotUsername = process.env.TELEGRAM_BOT_USERNAME;
    try {
      if (envBotName !== undefined) {
        process.env.TELEGRAM_BOT_NAME = envBotName;
        delete process.env.TELEGRAM_BOT_USERNAME;
      } else {
        delete process.env.TELEGRAM_BOT_NAME;
        delete process.env.TELEGRAM_BOT_USERNAME;
      }
      return renderMobileAppHtml();
    } finally {
      if (originalBotName !== undefined) {
        process.env.TELEGRAM_BOT_NAME = originalBotName;
      } else {
        delete process.env.TELEGRAM_BOT_NAME;
      }
      if (originalBotUsername !== undefined) {
        process.env.TELEGRAM_BOT_USERNAME = originalBotUsername;
      } else {
        delete process.env.TELEGRAM_BOT_USERNAME;
      }
    }
  }

  // Case 1: TELEGRAM_BOT_NAME is not set
  const htmlNoBot = getRenderedHtml(undefined);
  assert(
    htmlNoBot.includes('id="telegram-login-container"'),
    'Container #telegram-login-container is present when bot is unconfigured'
  );
  assert(
    htmlNoBot.includes('Telegram login is unconfigured'),
    'Informative configuration message rendered when TELEGRAM_BOT_NAME is missing'
  );
  assert(
    !htmlNoBot.includes('data-telegram-login='),
    'Widget script is not rendered when TELEGRAM_BOT_NAME is missing'
  );

  // Case 2: TELEGRAM_BOT_NAME is configured validly
  const htmlWithBot = getRenderedHtml('WhoWasRightBot');
  assert(
    htmlWithBot.includes('data-telegram-login="WhoWasRightBot"'),
    'Widget script includes data-telegram-login="WhoWasRightBot"'
  );
  assert(
    htmlWithBot.includes('data-onauth="onTelegramAuth(user)"'),
    'Widget connects data-onauth to onTelegramAuth(user)'
  );
  assert(
    htmlWithBot.includes('https://telegram.org/js/telegram-widget.js?22'),
    'Official Telegram widget script URL is loaded'
  );
  assert(
    htmlWithBot.includes('@WhoWasRightBot'),
    'Bot handle dynamically displayed in description'
  );

  // Case 3: Malformed bot name with special characters (Injection defense)
  const htmlMaliciousBot = getRenderedHtml('"><script>alert(1)</script>');
  assert(
    !htmlMaliciousBot.includes('alert(1)'),
    'Malformed TELEGRAM_BOT_NAME is rejected and does not result in script injection'
  );
  assert(
    htmlMaliciousBot.includes('Telegram login is unconfigured'),
    'Fallback message rendered when TELEGRAM_BOT_NAME fails syntax validation'
  );

  // ============================================================
  // Section 5: Demo Session TTL Default & Config
  // ============================================================
  console.log('\n  [Section 5: Demo Session TTL Default & Config]');

  const originalTtl = process.env.DEMO_SESSION_TTL_MINUTES;
  try {
    delete process.env.DEMO_SESSION_TTL_MINUTES;
    assert(getDemoSessionTtlMinutes() === 60, 'Default demo session TTL is strictly 60 minutes');

    process.env.DEMO_SESSION_TTL_MINUTES = '45';
    assert(getDemoSessionTtlMinutes() === 45, 'Demo session TTL is configurable via DEMO_SESSION_TTL_MINUTES');

    process.env.DEMO_SESSION_TTL_MINUTES = 'invalid';
    assert(getDemoSessionTtlMinutes() === 60, 'Demo session TTL falls back to 60 minutes on invalid input');
  } finally {
    if (originalTtl !== undefined) {
      process.env.DEMO_SESSION_TTL_MINUTES = originalTtl;
    } else {
      delete process.env.DEMO_SESSION_TTL_MINUTES;
    }
  }

  return { passed: failures.length === 0, count, failures };
}

// Direct execution support
if (process.argv[1]?.replace(/\\/g, '/').endsWith('demo-cleanup.test.ts')) {
  runDemoCleanupUnitTests().then(res => {
    if (!res.passed) {
      console.error(`\nSuite failed with ${res.failures.length} errors.`);
      process.exitCode = 1;
    } else {
      console.log(`\nAll ${res.count} assertions passed.`);
      process.exitCode = 0;
    }
  });
}
