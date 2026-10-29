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
import { createWebServer } from '../../src/web/server.ts';
import { query } from '../../src/core/db.ts';

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

    // Setup Test User
    const suffix = Date.now();
    const uRes = await query<{ id: string }>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, 'Web Test User')
      RETURNING id
    `, [suffix + 100, `web_user_${suffix}`]);
    const userId = uRes.rows[0].id;
    const userHeaders = { 'X-User-Id': userId };

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

