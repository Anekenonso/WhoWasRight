/**
 * Integration Test: Web Server & Mobile-First REST API
 *
 * Verifies:
 * 1. HTTP server lifecycle (starts and stops cleanly).
 * 2. Health check endpoint.
 * 3. Mobile HTML application delivery with responsive meta tags, light theme, 44px touch targets.
 * 4. Paste parser API (deterministic, zero AI, requiresReview).
 * 5. Daily limit API (soft guidance, UTC tracking).
 * 6. Analyst CRUD, alias linking, and reversible merge via API.
 * 7. Prediction logging via API with kickoff protection and duplicate rejection.
 */

import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { createWebServer } from '../../src/web/server.ts';
import { query } from './test-db.ts';
import { generateSessionToken, hashSessionToken } from '../../src/core/crypto.ts';

export async function runWebServerIntegrationTests(): Promise<{
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

  console.log('\n--- Running Web Server & Mobile UI Integration Tests ---');

  const server = createWebServer();
  const PORT = 3987; // Ephemeral test port
  await new Promise<void>(resolve => server.listen(PORT, resolve));

  const baseUrl = `http://localhost:${PORT}`;

  // Helper for HTTP requests
  async function request(path: string, options: { method?: string; body?: any; headers?: Record<string, string> } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const status = res.status;
    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status, data };
  }

  try {
    // 1. Health check
    const health = await request('/api/health');
    assert(health.status === 200, 'Health endpoint returns 200');
    assert(health.data.status === 'healthy', 'Health status is healthy');

    // 2. Mobile HTML UI
    const ui = await request('/');
    assert(ui.status === 200, 'Root delivers Mobile HTML UI with 200');
    assert(ui.data.includes('viewport') && ui.data.includes('width=device-width'), 'HTML includes mobile responsive viewport');
    assert(!ui.data.includes('user-scalable=no'), 'Accessibility: user-scalable=no is removed to allow user zoom');
    assert(!ui.data.includes('maximum-scale'), 'Accessibility: maximum-scale restriction removed');
    assert(ui.data.includes('--blue: #2563EB') && ui.data.includes('--navy: #0F172A'), 'HTML uses approved light theme colors');
    assert(ui.data.includes('min-height: 44px') && ui.data.includes('min-width: 44px'), 'Buttons satisfy 44x44px touch targets');
    assert(ui.data.includes('Add Another Prediction') && ui.data.includes('Back to Home'), 'Post-save inline actions exist');
    assert(ui.data.includes('Quick Paste Assistant'), 'Paste assistant component exists');
    assert(ui.data.includes('Merge Analyst Profiles'), 'Reversible merge modal exists');
    assert(ui.data.includes('id="tab-home"') && ui.data.includes('id="tab-predictions"'), 'Approved bottom nav: Home & Predictions');
    assert(ui.data.includes('id="tab-analysts"') && ui.data.includes('id="tab-settings"'), 'Approved bottom nav: Analysts & Settings');
    assert(ui.data.includes('id="screen-settings"'), 'Settings screen restored and accessible');
    assert(ui.data.includes('+ Log Pick'), 'Quick Log Pick action accessible from top bar');
    assert(!ui.data.includes('Weekly scorecards'), 'Settings does not contain unapproved weekly scorecards');
    assert(!ui.data.includes('Kickoff reminder'), 'Settings does not contain unapproved kickoff reminders');
    assert(!ui.data.includes('Export Data') && !ui.data.includes('Data Export'), 'Settings does not contain unapproved data export');
    assert(ui.data.includes('id="screen-analyst-detail"'), 'Phase 4: Analyst Detail screen exists in HTML');
    assert(ui.data.includes('id="analyst-credibility-preview"'), 'Phase 4: Inline credibility preview exists in logging form');
    assert(ui.data.includes('id="detail-rating-tier-badge"') && ui.data.includes('id="detail-win-rate"'), 'Phase 4: Credibility scorecard card exists in HTML');
    assert(ui.data.includes('id="detail-walrus-status"'), 'Phase 4: Decentralized Walrus sync status indicator exists');
    assert(ui.data.includes('id="btn-activate-bot"'), 'Phase 5: Enable Result Reminders button exists in Settings');
    assert(ui.data.includes('id="btn-toggle-notifications"'), 'Phase 5: Settlement notification toggle exists in Settings');

    // Setup Test User & Authenticated Session
    const suffix = Date.now();
    const uRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, 'Web Test User')
      RETURNING id
    `, [suffix + 100, `web_user_${suffix}`]);
    const userId = uRes.rows[0].id;

    const sessionToken = generateSessionToken();
    const tokenHash = hashSessionToken(sessionToken);
    await query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '1 day')
    `, [tokenHash, userId]);
    const userHeaders = { 'Authorization': `Bearer ${sessionToken}` };

    // --- PRODUCTION AUTHENTICATION HARDENING TESTS ---
    // Test 1: Unauthenticated request to protected endpoint fails closed with 401
    const unauthRes = await request('/api/analysts');
    assert(unauthRes.status === 401, 'Unauthenticated request to protected endpoint returns 401');
    assert(unauthRes.data.error === 'Authentication required', 'Unauthenticated error message is Authentication required');

    // Test 2: Expired session token is rejected with 401
    const expiredToken = generateSessionToken();
    const expHash = hashSessionToken(expiredToken);
    await query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, NOW() - INTERVAL '1 hour')
    `, [expHash, userId]);
    const expiredRes = await request('/api/analysts', { headers: { 'Authorization': `Bearer ${expiredToken}` } });
    assert(expiredRes.status === 401, 'Request with expired session token is rejected with 401');

    // Test 3: Invalid arbitrary bearer token is rejected with 401
    const invalidRes = await request('/api/analysts', { headers: { 'Authorization': 'Bearer non-existent-token-xyz' } });
    assert(invalidRes.status === 401, 'Invalid bearer token is rejected with 401');

    // Test 4: Client-supplied X-User-Id without valid session is rejected with 401 (cannot spoof identity)
    const spoofRes = await request('/api/analysts', { headers: { 'X-User-Id': userId } });
    assert(spoofRes.status === 401, 'Client cannot authenticate via spoofed X-User-Id header (fails closed with 401)');

    // Test 5: Client-supplied X-Dev-User-Id in production or without ALLOW_DEV_AUTH is rejected with 401
    const devHeaderRes = await request('/api/analysts', { headers: { 'X-Dev-User-Id': userId } });
    assert(devHeaderRes.status === 401, 'Development authentication header is rejected when not explicitly enabled with 401');

    // Test 6: Valid Telegram authentication endpoint (POST /api/auth/telegram)
    const tgLoginData = {
      id: suffix + 500,
      first_name: 'Telegram Real User',
      username: `tg_real_${suffix}`,
      auth_date: Math.floor(Date.now() / 1000),
    };
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const checkStr = Object.keys(tgLoginData).sort().map(k => `${k}=${(tgLoginData as any)[k]}`).join('\n');
    const secretKey = createHash('sha256').update(botToken!).digest();
    const validHash = createHmac('sha256', secretKey).update(checkStr).digest('hex');

    const tgAuthRes = await request('/api/auth/telegram', {
      method: 'POST',
      body: { ...tgLoginData, hash: validHash }
    });
    assert(tgAuthRes.status === 200, 'Valid Telegram authentication returns 200');
    assert(tgAuthRes.data.token !== undefined, 'Telegram auth issues valid session token');
    assert(tgAuthRes.data.user.username === tgLoginData.username, 'Telegram auth resolves correct user identity');

    // Test 7: GET /api/auth/me returns authenticated user
    const meRes = await request('/api/auth/me', { headers: { 'Authorization': `Bearer ${tgAuthRes.data.token}` } });
    assert(meRes.status === 200, 'GET /api/auth/me returns 200 for authenticated user');
    assert(meRes.data.authenticated === true, 'GET /api/auth/me confirms authenticated === true');
    assert(meRes.data.isDemo === false, 'Real Telegram user isDemo === false');

    // Test 8: Judge Demo Mode creation (POST /api/auth/demo)
    const demoRes = await request('/api/auth/demo', { method: 'POST' });
    assert(demoRes.status === 200, 'Judge Demo endpoint returns 200');
    assert(demoRes.data.isDemo === true, 'Judge Demo session is marked as isDemo === true');
    assert(demoRes.data.token && demoRes.data.token.startsWith('demo_'), 'Judge Demo issues demo session token');

    // Test 9: Judge Demo Mode data isolation - demo user cannot access or view real user records
    const demoHeaders = { 'Authorization': `Bearer ${demoRes.data.token}` };
    const demoAnalysts = await request('/api/analysts', { headers: demoHeaders });
    assert(demoAnalysts.status === 200, 'Demo session lists demo analysts');
    assert(demoAnalysts.data.analysts.length >= 2, 'Demo session has pre-seeded sample analysts');
    assert(!demoAnalysts.data.analysts.some((a: any) => a.user_id === userId), 'Demo session cannot access real user analyst records');

    // Test 10: User A session cannot access User B private analyst records (Cross-user ownership)
    const uBRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, 'User B') RETURNING id;
    `, [suffix + 900, `user_b_${suffix}`]);
    const userBId = uBRes.rows[0].id;
    const aBRes = await query<{ id: string }>(`
      INSERT INTO analysts (user_id, name) VALUES ($1, 'Private Analyst B') RETURNING id;
    `, [userBId]);
    const analystBId = aBRes.rows[0].id;

    const crossAccess = await request(`/api/analysts/${analystBId}`, { headers: userHeaders });
    assert(crossAccess.status === 404, 'User A session cannot access User B private analyst (returns 404 Not Found)');

    // Test 11: Sign out (POST /api/auth/logout) revokes session
    const logoutRes = await request('/api/auth/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${tgAuthRes.data.token}` } });
    assert(logoutRes.status === 200, 'POST /api/auth/logout returns 200');
    const meAfterLogout = await request('/api/auth/me', { headers: { 'Authorization': `Bearer ${tgAuthRes.data.token}` } });
    assert(meAfterLogout.status === 401, 'Session revoked after sign out (GET /api/auth/me returns 401)');

    // Phase 5 Bot Status & Activation API
    const botStatus = await request('/api/bot/status', { headers: userHeaders });
    assert(botStatus.status === 200, 'Phase 5: Bot status endpoint returns 200');
    assert(botStatus.data.linked === false, 'Phase 5: Fresh user bot is not linked');

    const botActivate = await request('/api/bot/activate', { method: 'POST', headers: userHeaders });
    assert(botActivate.status === 200, 'Phase 5: Bot activate endpoint returns 200');
    assert(botActivate.data.deepLink.includes('WhoWasRightBot'), 'Phase 5: Returns Telegram bot deep link');

    // Phase 5 Webhook Unauthenticated Denial
    const webhookNoAuth = await request('/api/telegram/webhook', { method: 'POST', body: { update_id: 1 } });
    assert(webhookNoAuth.status === 401, 'Phase 5: Webhook missing secret returns 401');

    // Phase 5 Cron Unauthenticated Denial
    const cronNoAuth = await request('/api/cron/settle', { method: 'POST' });
    assert(cronNoAuth.status === 401, 'Phase 5: Cron missing secret returns 401');

    // 3. Daily Limit API
    const limit = await request('/api/daily-limit', { headers: userHeaders });
    assert(limit.status === 200, 'Daily limit API returns 200');
    assert(limit.data.canSave === true, 'Daily limit canSave === true');
    assert(limit.data.status === 'NORMAL', 'Fresh user status is NORMAL');

    // 4. Paste Assistant API
    const paste = await request('/api/parse-paste', {
      method: 'POST',
      body: { text: 'Arsenal vs Chelsea - Over 2.5 goals. BTTS Yes.' }
    });
    assert(paste.status === 200, 'Paste assistant returns 200');
    assert(paste.data.requiresReview === true, 'Paste assistant requiresReview === true');
    assert(paste.data.extractedEventLabel === 'Arsenal vs Chelsea', 'Extracted event label');
    assert(paste.data.candidates.length === 2, 'Parsed 2 candidate predictions');

    // 5. Analyst Creation & Listing via API
    const newAnalyst = await request('/api/analysts', {
      method: 'POST',
      headers: userHeaders,
      body: {
        name: 'Gary Neville',
        aliases: [{ platform: 'twitter', handle: 'GNev2' }]
      }
    });
    assert(newAnalyst.status === 201, 'Analyst created via API returns 201');
    const analystId = newAnalyst.data.analyst.id;

    const listRes = await request('/api/analysts', { headers: userHeaders });
    assert(listRes.status === 200, 'List analysts returns 200');
    assert(listRes.data.analysts.length >= 1, 'Analyst list contains newly created analyst');

    // 5b. Phase 4 Analyst Detail Endpoint
    const detailRes = await request(`/api/analysts/${analystId}`, { headers: userHeaders });
    assert(detailRes.status === 200, 'Phase 4: Analyst detail endpoint returns 200');
    assert(detailRes.data.credibility !== undefined, 'Phase 4: Analyst detail returns credibility scorecard');
    assert(detailRes.data.credibility.ratingTier === 'Not Rated', 'Phase 4: Fresh analyst rating tier is Not Rated');
    assert(detailRes.data.credibility.historyBadge === 'Insufficient', 'Phase 4: Fresh analyst history badge is Insufficient');
    assert(Array.isArray(detailRes.data.predictions), 'Phase 4: Analyst detail includes predictions array');

    // 6. Prediction Logging via API
    const futureKickoff = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const predRes = await request('/api/predictions', {
      method: 'POST',
      headers: userHeaders,
      body: {
        sport: 'Football',
        eventLabel: `Manchester United vs Liverpool ${suffix}`,
        startAtUtc: futureKickoff,
        analystId: analystId,
        market: '1X2',
        selection: 'Liverpool'
      }
    });
    assert(predRes.status === 201, 'Prediction logged via API returns 201');
    assert(predRes.data.message === 'Prediction saved successfully.', 'Post-save message returned');
    assert(predRes.data.limitInfo.canSave === true, 'Response includes updated limit metadata');

    // 7. Multi-pick on same event
    const multiPick = await request('/api/predictions', {
      method: 'POST',
      headers: userHeaders,
      body: {
        eventId: predRes.data.prediction.event_id,
        analystId: analystId,
        market: 'BTTS',
        selection: 'Yes'
      }
    });
    assert(multiPick.status === 201, 'Multi-pick on same event returns 201');

    // 8. Exact Duplicate Rejection
    const dupRes = await request('/api/predictions', {
      method: 'POST',
      headers: userHeaders,
      body: {
        eventId: predRes.data.prediction.event_id,
        analystId: analystId,
        market: '1X2',
        selection: 'Liverpool'
      }
    });
    assert(dupRes.status === 400, 'Exact duplicate rejected with HTTP 400');

    // 9. Past Kickoff Rejection
    const pastKickoff = new Date(Date.now() - 3600 * 1000).toISOString();
    const pastRes = await request('/api/predictions', {
      method: 'POST',
      headers: userHeaders,
      body: {
        sport: 'Football',
        eventLabel: 'Past Event',
        startAtUtc: pastKickoff,
        analystId: analystId,
        market: '1X2',
        selection: 'Home'
      }
    });
    assert(pastRes.status === 400, 'Past kickoff prediction rejected with HTTP 400');

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

if (process.argv[1]?.replace(/\\/g, '/').endsWith('web-server.test.ts')) {
  runWebServerIntegrationTests()
    .then(r => {
      console.log(`\nWeb Server Tests: ${r.count - r.failures.length}/${r.count} passed.`);
      process.exit(r.passed ? 0 : 1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

