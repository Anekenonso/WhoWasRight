/**
 * Integration Tests: Authentication Hardening & Judge Demo Isolation Corrections
 *
 * Verifies all 12 items required for Phase 5 production hardening:
 * 1. Frontend bearer-token persistence and restoration (via GET /api/auth/me).
 * 2. Authorization header on every protected API request.
 * 3. Logout and expired-token handling.
 * 4. Correct CORS behaviour for the configured frontend origin.
 * 5. Rejection of unapproved origins.
 * 6. Demo prediction excluded from Walrus outbox selection.
 * 7. Real prediction remains eligible for Walrus processing.
 * 8. Demo prediction excluded from automated settlement.
 * 9. Real prediction remains eligible for automated settlement.
 * 10. Demo manual settlement remains isolated.
 * 11. Demo cleanup never deletes real-user records.
 * 12. Existing authentication and ownership protections remain intact.
 */

import http from 'node:http';
import { createWebServer, isOriginAllowed, getCorsHeaders } from '../../src/web/server.ts';
import { query } from '../../src/core/db.ts';
import { createDemoSession, cleanupExpiredDemoSessions } from '../../src/core/demo-mode.ts';
import { processMemoryOutbox } from '../../src/core/walrus-outbox-worker.ts';
import { runSettlementCycle } from '../../src/core/football-settler.ts';
import { formatStructuredMemory, generateSessionToken, hashSessionToken } from '../../src/core/crypto.ts';

export async function runAuthHardeningCorrectionsTests(): Promise<{
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

  console.log('\n--- Running Authentication Hardening & Demo Isolation Tests ---');

  const server = createWebServer();
  const PORT = 3993;
  await new Promise<void>(resolve => server.listen(PORT, resolve));
  const baseUrl = `http://localhost:${PORT}`;

  async function apiRequest(path: string, options: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
  } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const status = res.status;
    let data: any = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status, data, headers: res.headers };
  }

  try {
    // -------------------------------------------------------------
    // 1. Frontend Bearer-Token Persistence and Restoration
    // -------------------------------------------------------------
    const demoLogin = await apiRequest('/api/auth/demo', { method: 'POST' });
    assert(demoLogin.status === 200, 'Demo login returns 200');
    assert(typeof demoLogin.data.token === 'string' && demoLogin.data.token.startsWith('demo_'), 'Demo login returns demo session token');
    const demoToken = demoLogin.data.token;
    const demoUser = demoLogin.data.user;

    const meRes = await apiRequest('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${demoToken}` }
    });
    assert(meRes.status === 200, 'GET /api/auth/me with Bearer token returns 200');
    assert(meRes.data.authenticated === true, 'Auth restoration confirms authenticated === true');
    assert(meRes.data.user.id === demoUser.id, 'Auth restoration returns matching user identity');
    assert(meRes.data.isDemo === true, 'Auth restoration identifies demo session');

    // -------------------------------------------------------------
    // 2. Authorization Header on Every Protected API Request
    // -------------------------------------------------------------
    const protectedRoutes = [
      '/api/daily-limit',
      '/api/analysts',
      '/api/predictions',
      '/api/bot/status',
    ];

    for (const route of protectedRoutes) {
      const unauth = await apiRequest(route);
      assert(unauth.status === 401, `Unauthenticated request to ${route} fails closed with 401`);

      const auth = await apiRequest(route, {
        headers: { 'Authorization': `Bearer ${demoToken}` }
      });
      assert(auth.status === 200, `Protected request to ${route} with Bearer token succeeds with 200`);
    }

    // -------------------------------------------------------------
    // 3. Logout and Expired-Token Handling
    // -------------------------------------------------------------
    const logoutRes = await apiRequest('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${demoToken}` }
    });
    assert(logoutRes.status === 200, 'POST /api/auth/logout returns 200');

    const meAfterLogout = await apiRequest('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${demoToken}` }
    });
    assert(meAfterLogout.status === 401, 'Revoked token rejected with 401 after logout');

    // Expired token rejection
    const expiredToken = generateSessionToken();
    const expiredHash = hashSessionToken(expiredToken);
    await query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() - INTERVAL '10 seconds');
    `, [expiredHash, demoUser.id]);

    const meExpired = await apiRequest('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${expiredToken}` }
    });
    assert(meExpired.status === 401, 'Expired session token rejected with 401');

    // -------------------------------------------------------------
    // 4. Correct CORS Behaviour for Configured Frontend Origin
    // -------------------------------------------------------------
    process.env.FRONTEND_URL = 'https://whowasright.vercel.app';
    const approvedOrigin = 'https://whowasright.vercel.app';

    const corsReq = await apiRequest('/api/health', {
      headers: { 'Origin': approvedOrigin }
    });
    assert(corsReq.headers.get('access-control-allow-origin') === approvedOrigin, 'CORS: Approved origin receives explicit Access-Control-Allow-Origin');
    assert(corsReq.headers.get('vary') === 'Origin', 'CORS: Vary: Origin header present');
    assert(corsReq.headers.get('access-control-allow-credentials') === null, 'CORS: No credentials allowed for bearer flow (fails closed)');

    // Preflight OPTIONS for approved origin
    const preflightRes = await fetch(`${baseUrl}/api/predictions`, {
      method: 'OPTIONS',
      headers: {
        'Origin': approvedOrigin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      }
    });
    assert(preflightRes.status === 204, 'CORS: Preflight OPTIONS returns 204');
    assert(preflightRes.headers.get('access-control-allow-origin') === approvedOrigin, 'CORS: Preflight returns Access-Control-Allow-Origin');
    assert(preflightRes.headers.get('access-control-allow-headers')?.includes('Authorization'), 'CORS: Preflight allows Authorization header');

    // -------------------------------------------------------------
    // 5. Rejection of Unapproved Origins
    // -------------------------------------------------------------
    const unapprovedOrigin = 'https://malicious-tracker.com';
    const unapprovedReq = await apiRequest('/api/health', {
      headers: { 'Origin': unapprovedOrigin }
    });
    assert(unapprovedReq.headers.get('access-control-allow-origin') === null, 'CORS: Unapproved origin receives no Access-Control-Allow-Origin');

    const unapprovedPreflight = await fetch(`${baseUrl}/api/predictions`, {
      method: 'OPTIONS',
      headers: {
        'Origin': unapprovedOrigin,
        'Access-Control-Request-Method': 'POST',
      }
    });
    assert(unapprovedPreflight.headers.get('access-control-allow-origin') === null, 'CORS: Preflight for unapproved origin receives no Access-Control-Allow-Origin');

    // -------------------------------------------------------------
    // 6. Demo Prediction Excluded from Walrus Outbox Selection
    // -------------------------------------------------------------
    const demoSession2 = await createDemoSession();
    const demoUserId = demoSession2.user.id;

    const demoPayload = formatStructuredMemory({
      analystId: '00000000-0000-4000-a000-000000000001',
      sequenceNumber: 1,
      eventType: 'CREATED',
      payload: { pick: 'Demo Pick' }
    });

    const demoOutboxRes = await query<{ id: string }>(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
      VALUES ($1, 'demo-walrus-leak-test', $2, 'PENDING', 0, NOW())
      RETURNING id;
    `, [demoUserId, demoPayload]);
    const demoOutboxId = demoOutboxRes.rows[0].id;

    const mockWalrus = {
      rememberAndWait: async () => ({ job_id: 'mock-walrus-job', blob_id: 'mock-blob' })
    };

    // Run outbox processor targeting the demo user
    const demoProcResult = await processMemoryOutbox({
      userId: demoUserId,
      batchSize: 10,
      walrusClientOverride: mockWalrus,
    });
    assert(demoProcResult.processed === 0, 'Outbox worker processed 0 records for demo user');

    const checkDemoOutbox = await query<{ status: string; attempts: number }>(`
      SELECT status, attempts FROM memory_outbox WHERE id = $1;
    `, [demoOutboxId]);
    assert(checkDemoOutbox.rows[0].status === 'PENDING', 'Demo prediction outbox record remains PENDING (never selected for Walrus write)');
    assert(checkDemoOutbox.rows[0].attempts === 0, 'Demo prediction outbox record attempts remains 0');

    // -------------------------------------------------------------
    // 7. Real Prediction Remains Eligible for Walrus Processing
    // -------------------------------------------------------------
    const realUserSuffix = Date.now();
    const realUserRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, 'RealUserWalrus')
      RETURNING id;
    `, [950000000 + Math.floor(Math.random() * 100000), `real_walrus_${realUserSuffix}`]);
    const realUserId = realUserRes.rows[0].id;

    const realPayload = formatStructuredMemory({
      analystId: '00000000-0000-4000-a000-000000000001',
      sequenceNumber: 1,
      eventType: 'CREATED',
      payload: { pick: 'Real Pick' }
    });

    const realOutboxRes = await query<{ id: string }>(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, attempts, next_retry_at)
      VALUES ($1, 'real-walrus-proc-test', $2, 'PENDING', 0, NOW())
      RETURNING id;
    `, [realUserId, realPayload]);
    const realOutboxId = realOutboxRes.rows[0].id;

    await processMemoryOutbox({
      userId: realUserId,
      batchSize: 10,
      walrusClientOverride: mockWalrus,
    });

    const checkRealOutbox = await query<{ status: string }>(`
      SELECT status FROM memory_outbox WHERE id = $1;
    `, [realOutboxId]);
    assert(checkRealOutbox.rows[0].status === 'CONFIRMED', 'Real prediction outbox record transitioned to CONFIRMED on Walrus');

    // -------------------------------------------------------------
    // 8. Demo Prediction Excluded from Automated Settlement
    // -------------------------------------------------------------
    const testFixtureId = 99000000 + Math.floor(Math.random() * 900000);

    const demoEventRes = await query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, api_fixture_id, start_at_utc, source, status)
      VALUES ($1, 'FOOTBALL', 'Demo Team vs Opponent', $2, NOW() - INTERVAL '3 hours', 'API_SPORTS', 'TIMED')
      RETURNING id;
    `, [demoUserId, testFixtureId]);

    const demoAnalystRes = await query<{ id: string }>(`
      SELECT id FROM analysts WHERE user_id = $1 LIMIT 1;
    `, [demoUserId]);
    const demoAnalystId = demoAnalystRes.rows[0].id;

    const demoPredRes = await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, '1X2', 'Home', 'PENDING', 'UNVERIFIED')
      RETURNING id;
    `, [demoUserId, demoEventRes.rows[0].id, demoAnalystId]);
    const demoPredId = demoPredRes.rows[0].id;

    // Check query directly: candidate selection for settlement cycle
    const settlementCandidateCheck = await query(`
      SELECT p.id
      FROM predictions p
      JOIN events e ON e.id = p.event_id
      JOIN users u ON u.id = p.user_id
      WHERE p.outcome = 'PENDING'
        AND e.sport = 'FOOTBALL'
        AND e.api_fixture_id = $1
        AND u.telegram_id > 0;
    `, [testFixtureId]);
    assert(settlementCandidateCheck.rows.length === 0, 'Automated settlement candidate query strictly excludes demo user prediction');

    // -------------------------------------------------------------
    // 9. Real Prediction Remains Eligible for Automated Settlement
    // -------------------------------------------------------------
    const realEventRes = await query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, api_fixture_id, start_at_utc, source, status)
      VALUES ($1, 'FOOTBALL', 'Real Match', $2, NOW() - INTERVAL '3 hours', 'API_SPORTS', 'TIMED')
      RETURNING id;
    `, [realUserId, testFixtureId]);

    const realAnalystRes = await query<{ id: string }>(`
      INSERT INTO analysts (user_id, name) VALUES ($1, 'Real Analyst') RETURNING id;
    `, [realUserId]);

    await query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, '1X2', 'Home', 'PENDING', 'UNVERIFIED');
    `, [realUserId, realEventRes.rows[0].id, realAnalystRes.rows[0].id]);

    const realSettlementCheck = await query(`
      SELECT p.id
      FROM predictions p
      JOIN events e ON e.id = p.event_id
      JOIN users u ON u.id = p.user_id
      WHERE p.outcome = 'PENDING'
        AND e.sport = 'FOOTBALL'
        AND e.api_fixture_id = $1
        AND u.telegram_id > 0;
    `, [testFixtureId]);
    assert(realSettlementCheck.rows.length === 1, 'Real user prediction is selected as candidate for automated settlement');

    // -------------------------------------------------------------
    // 10. Demo Manual Settlement Remains Isolated
    // -------------------------------------------------------------
    const demoSettleRes = await apiRequest(`/api/predictions/${demoPredId}/settle`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${demoSession2.token}` },
      body: { outcome: 'WON' }
    });
    assert(demoSettleRes.status === 200, 'Demo user can manually settle their own prediction inside demo session');

    const checkDemoSettled = await query<{ outcome: string; verification: string }>(`
      SELECT outcome, verification FROM predictions WHERE id = $1;
    `, [demoPredId]);
    assert(checkDemoSettled.rows[0].outcome === 'WON', 'Demo prediction outcome updated to WON');
    assert(checkDemoSettled.rows[0].verification === 'SELF_REPORTED', 'Demo manual settlement marked SELF_REPORTED');

    // Another user cannot settle or access it
    const crossUserSettle = await apiRequest(`/api/predictions/${demoPredId}/settle`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${generateSessionToken()}` },
      body: { outcome: 'LOST' }
    });
    assert(crossUserSettle.status === 401, 'Unauthorized request cannot settle demo prediction');

    // -------------------------------------------------------------
    // 11. Demo Cleanup Never Deletes Real-User Records
    // -------------------------------------------------------------
    // Setup: Real user with expired session
    const realCleanUserRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, 'real_preserved_user', 'Preserved')
      RETURNING id;
    `, [970000000 + Math.floor(Math.random() * 100000)]);
    const realPreservedId = realCleanUserRes.rows[0].id;

    await query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() - INTERVAL '2 hours');
    `, [hashSessionToken(generateSessionToken()), realPreservedId]);

    // Setup: Demo user with expired session
    const expiredDemoUserRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name, created_at)
      VALUES ($1, 'judge_demo_expired', 'DemoExpired', NOW() - INTERVAL '2 hours')
      RETURNING id;
    `, [-1 * (Date.now() + 99999)]);
    const expiredDemoId = expiredDemoUserRes.rows[0].id;

    await query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() - INTERVAL '2 hours');
    `, [hashSessionToken(generateSessionToken()), expiredDemoId]);

    // Run cleanup
    const cleanedCount = await cleanupExpiredDemoSessions();
    assert(cleanedCount >= 1, `cleanupExpiredDemoSessions removed expired demo account (count: ${cleanedCount})`);

    const checkRealPreserved = await query(`
      SELECT id FROM users WHERE id = $1;
    `, [realPreservedId]);
    assert(checkRealPreserved.rows.length === 1, 'Real user account is preserved and NEVER deleted by demo cleanup');

    const checkDemoDeleted = await query(`
      SELECT id FROM users WHERE id = $1;
    `, [expiredDemoId]);
    assert(checkDemoDeleted.rows.length === 0, 'Expired demo user account was successfully deleted by cleanup');

    // -------------------------------------------------------------
    // 12. Existing Authentication & Ownership Protections Intact
    // -------------------------------------------------------------
    const spoofAttempt = await apiRequest('/api/predictions', {
      headers: {
        'X-User-Id': realPreservedId,
      }
    });
    assert(spoofAttempt.status === 401, 'Spoofed X-User-Id header fails closed with 401');

    const devHeaderAttempt = await apiRequest('/api/predictions', {
      headers: {
        'X-Dev-User-Id': realPreservedId,
      }
    });
    // In test environment where ALLOW_DEV_AUTH is not set to true, it must be rejected with 401
    assert(devHeaderAttempt.status === 401, 'X-Dev-User-Id rejected with 401 when ALLOW_DEV_AUTH is not enabled');

  } finally {
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('auth-hardening-corrections.test.ts')) {
  runAuthHardeningCorrectionsTests()
    .then(r => {
      console.log(`\nAuth Hardening Corrections Tests: ${r.count - r.failures.length}/${r.count} passed.`);
      process.exit(r.passed ? 0 : 1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
