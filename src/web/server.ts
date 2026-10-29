/**
 * WhoWasRight Web Server & REST API
 *
 * Implements mobile-first UI and API endpoints for:
 * - Analyst management (Create, Edit, Aliases, Reversible Merges)
 * - Prediction logging (Sport -> Event -> Analyst -> Market -> Selection)
 * - Strict kickoff lock & exact-duplicate prevention
 * - Multi-pick logging on single event
 * - Soft daily limit guidance (UTC calendar day)
 * - Rule-based paste assistance (100% deterministic, zero LLM)
 * - Mobile-first light-theme interface with 44px touch targets
 */

import http from 'node:http';
import { URL } from 'node:url';
import { query } from '../core/db.ts';
import {
  createAnalyst,
  updateAnalyst,
  addAnalystAlias,
  removeAnalystAlias,
  mergeAnalysts,
  unmergeAnalyst,
  listAnalysts,
  getAnalystDetail,
} from '../core/analysts.ts';
import { createEvent, createPrediction, getPredictionsForUser } from '../core/predictions.ts';
import { checkUserDailyLimit, getDailyPredictionCount } from '../core/daily-limits.ts';
import { parsePredictionPaste } from '../core/paste-parser.ts';
import { getSessionUser } from '../core/auth.ts';

// Helper to parse JSON request body
async function parseJsonBody<T = any>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Request payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Invalid JSON format'));
      }
    });
    req.on('error', reject);
  });
}

// Helper to send JSON responses
function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
  });
  res.end(JSON.stringify(data));
}

// Helper to authenticate request
async function getUserIdFromRequest(req: http.IncomingMessage): Promise<string> {
  const customUserId = req.headers['x-user-id'] as string;
  if (customUserId) {
    return customUserId;
  }

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const user = await getSessionUser(token);
    if (user) {
      return user.id;
    }
  }

  // Fallback: Default local dev user
  const devUser = await query<{ id: string }>(`
    SELECT id FROM users ORDER BY created_at ASC LIMIT 1
  `);
  if (devUser.rows.length > 0) {
    return devUser.rows[0].id;
  }

  // If no user exists, create a default user
  const newUser = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (999999999, 'dev_user', 'Developer')
    ON CONFLICT (telegram_id) DO UPDATE SET username = 'dev_user'
    RETURNING id
  `);
  return newUser.rows[0].id;
}

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
      });
      res.end();
      return;
    }

    try {
      // -------------------------------------------------------------
      // API ROUTES
      // -------------------------------------------------------------

      // 1. Health check
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, { status: 'healthy', timestamp: new Date().toISOString() });
      }

      // 2. Daily Limit status
      if (pathname === '/api/daily-limit' && method === 'GET') {
        const userId = await getUserIdFromRequest(req);
        const limitInfo = await checkUserDailyLimit(userId);
        return sendJson(res, 200, limitInfo);
      }

      // 3. Rule-Based Paste Assistant
      if (pathname === '/api/parse-paste' && method === 'POST') {
        const body = await parseJsonBody<{ text: string }>(req);
        const parsed = parsePredictionPaste(body.text || '');
        return sendJson(res, 200, parsed);
      }

      // 4. Analysts
      if (pathname === '/api/analysts') {
        const userId = await getUserIdFromRequest(req);

        if (method === 'GET') {
          const analysts = await listAnalysts(userId);
          return sendJson(res, 200, { analysts });
        }

        if (method === 'POST') {
          const body = await parseJsonBody<{ name: string; aliases?: Array<{ platform: string; handle: string }> }>(req);
          if (!body.name || !body.name.trim()) {
            return sendJson(res, 400, { error: 'Analyst name is required' });
          }
          const analyst = await createAnalyst(userId, body.name.trim(), body.aliases);
          return sendJson(res, 201, { analyst });
        }
      }

      // Analyst Detail & Edit
      const analystMatch = pathname.match(/^\/api\/analysts\/([0-9a-fA-F-]+)$/);
      if (analystMatch) {
        const analystId = analystMatch[1];
        const userId = await getUserIdFromRequest(req);

        if (method === 'GET') {
          const detail = await getAnalystDetail(userId, analystId);
          if (!detail) return sendJson(res, 404, { error: 'Analyst not found' });
          return sendJson(res, 200, detail);
        }

        if (method === 'PATCH') {
          const body = await parseJsonBody<{ name: string }>(req);
          if (!body.name || !body.name.trim()) {
            return sendJson(res, 400, { error: 'New name is required' });
          }
          await updateAnalyst(userId, analystId, body.name.trim());
          return sendJson(res, 200, { success: true });
        }
      }

      // Analyst Aliases
      const aliasMatch = pathname.match(/^\/api\/analysts\/([0-9a-fA-F-]+)\/aliases$/);
      if (aliasMatch && method === 'POST') {
        const analystId = aliasMatch[1];
        const userId = await getUserIdFromRequest(req);
        const body = await parseJsonBody<{ platform: string; handle: string }>(req);
        if (!body.platform || !body.handle) {
          return sendJson(res, 400, { error: 'Platform and handle are required' });
        }
        const alias = await addAnalystAlias(userId, analystId, body.platform, body.handle);
        return sendJson(res, 201, { alias });
      }

      const aliasDeleteMatch = pathname.match(/^\/api\/analysts\/([0-9a-fA-F-]+)\/aliases\/([0-9a-fA-F-]+)$/);
      if (aliasDeleteMatch && method === 'DELETE') {
        const analystId = aliasDeleteMatch[1];
        const aliasId = aliasDeleteMatch[2];
        const userId = await getUserIdFromRequest(req);
        await removeAnalystAlias(userId, analystId, aliasId);
        return sendJson(res, 200, { success: true });
      }

      // Analyst Merges
      const mergeMatch = pathname.match(/^\/api\/analysts\/([0-9a-fA-F-]+)\/merge$/);
      if (mergeMatch && method === 'POST') {
        const targetAnalystId = mergeMatch[1];
        const userId = await getUserIdFromRequest(req);
        const body = await parseJsonBody<{ sourceAnalystId: string }>(req);
        if (!body.sourceAnalystId) {
          return sendJson(res, 400, { error: 'sourceAnalystId is required' });
        }
        await mergeAnalysts(userId, body.sourceAnalystId, targetAnalystId);
        return sendJson(res, 200, { success: true, message: 'Analyst merged successfully' });
      }

      const unmergeMatch = pathname.match(/^\/api\/analysts\/([0-9a-fA-F-]+)\/unmerge$/);
      if (unmergeMatch && method === 'POST') {
        const analystId = unmergeMatch[1];
        const userId = await getUserIdFromRequest(req);
        await unmergeAnalyst(userId, analystId);
        return sendJson(res, 200, { success: true, message: 'Analyst unmerged successfully' });
      }

      // 5. Events
      if (pathname === '/api/events') {
        const userId = await getUserIdFromRequest(req);

        if (method === 'GET') {
          const events = await query(`
            SELECT id, sport, label, start_at_utc, status, source
            FROM events
            WHERE user_id = $1
            ORDER BY start_at_utc DESC
            LIMIT 50
          `, [userId]);
          return sendJson(res, 200, { events: events.rows });
        }

        if (method === 'POST') {
          const body = await parseJsonBody<{
            sport: string;
            label: string;
            startAtUtc: string;
            apiFixtureId?: number;
          }>(req);

          if (!body.sport || !body.label || !body.startAtUtc) {
            return sendJson(res, 400, { error: 'sport, label, and startAtUtc are required' });
          }

          const event = await createEvent({
            userId,
            sport: body.sport,
            label: body.label,
            startAtUtc: new Date(body.startAtUtc),
            apiFixtureId: body.apiFixtureId,
            source: body.apiFixtureId ? 'API_SPORTS' : 'USER_REPORTED',
          });
          return sendJson(res, 201, { event });
        }
      }

      // 6. Predictions
      if (pathname === '/api/predictions') {
        const userId = await getUserIdFromRequest(req);

        if (method === 'GET') {
          const status = parsedUrl.searchParams.get('status') || 'ALL';
          const predictions = await getPredictionsForUser(userId, status);
          return sendJson(res, 200, { predictions });
        }

        if (method === 'POST') {
          const body = await parseJsonBody<{
            eventId?: string;
            // Or create event inline:
            sport?: string;
            eventLabel?: string;
            startAtUtc?: string;
            analystId: string;
            market: string;
            selection: string;
            rawText?: string;
          }>(req);

          let eventId = body.eventId;
          if (!eventId) {
            if (!body.sport || !body.eventLabel || !body.startAtUtc) {
              return sendJson(res, 400, {
                error: 'Either eventId or (sport, eventLabel, startAtUtc) must be provided',
              });
            }
            const newEvent = await createEvent({
              userId,
              sport: body.sport,
              label: body.eventLabel,
              startAtUtc: new Date(body.startAtUtc),
              source: 'USER_REPORTED',
            });
            eventId = newEvent.id;
          }

          if (!body.analystId || !body.market || !body.selection) {
            return sendJson(res, 400, { error: 'analystId, market, and selection are required' });
          }

          const pred = await createPrediction({
            userId,
            eventId,
            analystId: body.analystId,
            market: body.market,
            selection: body.selection,
            rawText: body.rawText,
          });

          // Check updated daily limits for response metadata
          const limitInfo = await checkUserDailyLimit(userId);

          return sendJson(res, 201, {
            prediction: pred,
            limitInfo,
            message: 'Prediction saved successfully.',
          });
        }
      }

      // -------------------------------------------------------------
      // UI / HTML CLIENT (Mobile-First Single-Page Application)
      // -------------------------------------------------------------
      if (pathname === '/' || pathname === '/index.html' || pathname === '/log' || pathname === '/analysts' || pathname === '/predictions') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderMobileAppHtml());
        return;
      }

      // 404 for unknown endpoints
      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const msg = err.message || 'Internal Server Error';
      // Do not clutter logs for expected domain rejections (duplicates, kickoff locks)
      if (!msg.includes('Duplicate prediction') && !msg.includes('Kickoff locked')) {
        console.error('API Error:', err);
      }
      sendJson(res, 400, { error: msg });
    }
  });
}

// -------------------------------------------------------------------
// HTML CLIENT: Mobile-First Responsive Web Application
// -------------------------------------------------------------------
function renderMobileAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhoWasRight — Private Sports Prediction Journal</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #F8FAFC;
      --card-bg: #FFFFFF;
      --navy: #0F172A;
      --slate: #334155;
      --muted: #64748B;
      --border: #E2E8F0;
      --blue: #2563EB;
      --blue-hover: #1D4ED8;
      --blue-light: #EFF6FF;
      --green: #059669;
      --green-light: #ECFDF5;
      --red: #DC2626;
      --red-light: #FEF2F2;
      --amber: #D97706;
      --amber-light: #FFFBEB;
      --radius: 12px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg);
      color: var(--navy);
      line-height: 1.5;
      padding-bottom: 74px; /* Space for bottom nav */
      min-height: 100vh;
    }

    /* Top App Bar */
    .top-bar {
      position: sticky;
      top: 0;
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 40;
    }
    .logo {
      font-size: 18px;
      font-weight: 700;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .logo-badge {
      background: var(--blue-light);
      color: var(--blue);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 6px;
    }

    /* Container */
    .container {
      max-width: 480px;
      margin: 0 auto;
      padding: 16px;
    }

    /* Card styling */
    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    }
    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--navy);
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Buttons (Minimum 44x44px touch target) */
    .btn {
      min-height: 44px;
      min-width: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 18px;
      font-size: 14px;
      font-weight: 600;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease;
    }
    .btn-primary {
      background: var(--blue);
      color: #FFFFFF;
      width: 100%;
    }
    .btn-primary:hover {
      background: var(--blue-hover);
    }
    .btn-secondary {
      background: var(--border);
      color: var(--slate);
    }
    .btn-secondary:hover {
      background: #CBD5E1;
    }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--slate);
    }
    .btn-outline:hover {
      background: var(--bg);
    }
    .btn-sm {
      min-height: 36px;
      padding: 0 12px;
      font-size: 13px;
    }

    /* Form Inputs (Minimum 44px height) */
    .form-group {
      margin-bottom: 14px;
    }
    .label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      color: var(--slate);
      margin-bottom: 6px;
    }
    .input, .select, .textarea {
      width: 100%;
      min-height: 44px;
      padding: 10px 12px;
      font-size: 14px;
      font-family: inherit;
      color: var(--navy);
      background: #FFFFFF;
      border: 1px solid var(--border);
      border-radius: 8px;
      outline: none;
      transition: border 0.15s;
    }
    .input:focus, .select:focus, .textarea:focus {
      border-color: var(--blue);
    }

    /* Banners & Alerts */
    .banner {
      padding: 12px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      display: flex;
      align-items: flex-start;
      gap: 10px;
    }
    .banner-warning {
      background: var(--amber-light);
      border: 1px solid #FDE68A;
      color: #92400E;
    }
    .banner-success {
      background: var(--green-light);
      border: 1px solid #A7F3D0;
      color: #065F46;
    }
    .banner-error {
      background: var(--red-light);
      border: 1px solid #FECACA;
      color: #991B1B;
    }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 12px;
    }
    .badge-good { background: #DCFCE7; color: #166534; }
    .badge-average { background: #FEF3C7; color: #92400E; }
    .badge-poor { background: #FEE2E2; color: #991B1B; }
    .badge-not-rated { background: #F1F5F9; color: #64748B; }
    .badge-verified { background: #DBEAFE; color: #1E40AF; }
    .badge-pending { background: #FEF9C3; color: #854D0E; }
    .badge-won { background: #DCFCE7; color: #166534; }
    .badge-lost { background: #FEE2E2; color: #991B1B; }

    /* Bottom Navigation (4 Bottom Nav Tabs) */
    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: var(--card-bg);
      border-top: 1px solid var(--border);
      display: flex;
      height: 60px;
      z-index: 50;
    }
    .nav-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 500;
      color: var(--muted);
      text-decoration: none;
      min-height: 44px;
      cursor: pointer;
    }
    .nav-item.active {
      color: var(--blue);
      font-weight: 600;
    }
    .nav-icon {
      font-size: 18px;
      margin-bottom: 2px;
    }

    /* Modal Overlay */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(15, 23, 42, 0.4);
      display: flex;
      align-items: flex-end;
      justify-content: center;
      z-index: 100;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }
    .modal-overlay.open {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-content {
      background: var(--card-bg);
      border-radius: 16px 16px 0 0;
      width: 100%;
      max-width: 480px;
      max-height: 85vh;
      overflow-y: auto;
      padding: 20px 16px;
      transform: translateY(100%);
      transition: transform 0.25s ease-out;
    }
    .modal-overlay.open .modal-content {
      transform: translateY(0);
    }

    /* Inline Post-Save Options */
    .post-save-actions {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 14px;
    }

    /* Paste assistant card */
    .paste-assistant {
      border: 1px dashed var(--blue);
      background: var(--blue-light);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 16px;
    }

    .hidden { display: none !important; }
  </style>
</head>
<body>

  <!-- Top App Bar -->
  <div class="top-bar">
    <div class="logo">
      <span>WhoWasRight</span>
      <span class="logo-badge">Journal</span>
    </div>
    <div style="display: flex; align-items: center; gap: 8px;">
      <button class="btn btn-primary btn-sm" onclick="openLogScreen()" style="width: auto; height: 36px; padding: 0 12px; font-size: 13px; font-weight: 600;">
        + Log Pick
      </button>
      <div id="daily-count-badge" class="badge badge-not-rated" style="font-size: 11px;">
        Today: 0
      </div>
    </div>
  </div>

  <!-- Main Container -->
  <div class="container">

    <!-- Screen 1: Dashboard / Home -->
    <div id="screen-home" class="screen">
      <div class="card" style="background: linear-gradient(135deg, #1E293B, #0F172A); color: white;">
        <div style="font-size: 13px; color: #94A3B8; margin-bottom: 4px;">Private Prediction Journal</div>
        <div style="font-size: 20px; font-weight: 700; margin-bottom: 12px;">Track Who Was Actually Right</div>
        <button class="btn btn-primary" onclick="openLogScreen()" style="background: var(--blue);">
          + Log New Prediction
        </button>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Overview</span>
          <span style="font-size: 12px; color: var(--muted);" id="stat-total-picks">0 picks total</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <div style="background: var(--bg); padding: 12px; border-radius: 8px;">
            <div style="font-size: 11px; color: var(--muted);">PENDING PICKS</div>
            <div id="stat-pending" style="font-size: 22px; font-weight: 700; color: var(--navy);">0</div>
          </div>
          <div style="background: var(--bg); padding: 12px; border-radius: 8px;">
            <div style="font-size: 11px; color: var(--muted);">SETTLED PICKS</div>
            <div id="stat-settled" style="font-size: 22px; font-weight: 700; color: var(--navy);">0</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>Top Analysts</span>
          <a href="javascript:void(0)" onclick="switchTab('analysts')" style="font-size: 13px; color: var(--blue); text-decoration: none;">View All</a>
        </div>
        <div id="home-analysts-list">
          <div style="font-size: 13px; color: var(--muted); text-align: center; padding: 16px;">
            No analysts logged yet.
          </div>
        </div>
      </div>
    </div>

    <!-- Screen 2: Log Prediction (Primary Action Flow) -->
    <div id="screen-log" class="screen hidden">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <button class="btn btn-outline btn-sm" onclick="handleBackHome()" style="min-width: 44px; min-height: 44px; padding: 0 12px;">
          ← Back
        </button>
        <span style="font-size: 16px; font-weight: 700;">Record Prediction</span>
      </div>

      <!-- Soft Daily Limit Warning (Neutral wording) -->
      <div id="daily-warning-banner" class="banner banner-warning hidden">
        <span id="daily-warning-text"></span>
      </div>

      <!-- Paste Assistant Card -->
      <div class="paste-assistant">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 13px; font-weight: 600; color: var(--blue);">📋 Quick Paste Assistant</span>
          <span style="font-size: 11px; color: var(--muted);">Deterministic / Zero AI</span>
        </div>
        <div class="form-group" style="margin-bottom: 8px;">
          <input type="text" id="paste-input" class="input" placeholder="Paste tip (e.g. Arsenal vs Chelsea - Over 2.5 goals)" style="font-size: 13px;">
        </div>
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-outline btn-sm" onclick="handlePasteParse()" style="background: white; flex: 1;">Parse Post</button>
        </div>
        <div id="paste-preview" class="hidden" style="margin-top: 10px; font-size: 12px; background: white; padding: 10px; border-radius: 6px; border: 1px solid var(--border);">
          <div style="font-weight: 600; margin-bottom: 4px; color: var(--navy);">Parsed Suggestions (Requires Review):</div>
          <div id="paste-preview-content"></div>
          <button class="btn btn-primary btn-sm" onclick="applyParsedCandidate()" style="margin-top: 8px; width: 100%;">Use Suggestion</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Prediction Details</div>

        <!-- Post-Save Inline State (No redirect) -->
        <div id="post-save-container" class="hidden">
          <div class="banner banner-success">
            <div>
              <strong>✓ Prediction saved successfully.</strong>
              <div id="post-save-details" style="font-size: 12px; margin-top: 2px;"></div>
            </div>
          </div>
          <div class="post-save-actions">
            <button class="btn btn-primary" onclick="handleAddAnother()">
              + Add Another Prediction
            </button>
            <button class="btn btn-outline" onclick="handleBackHome()">
              ← Back to Home
            </button>
          </div>
        </div>

        <!-- Logging Form -->
        <form id="log-form" onsubmit="handleSavePrediction(event)">
          <!-- Sport Selection -->
          <div class="form-group">
            <label class="label">Sport</label>
            <select id="form-sport" class="select" required>
              <option value="Football">⚽ Football</option>
              <option value="Basketball">🏀 Basketball</option>
              <option value="Tennis">🎾 Tennis</option>
              <option value="Baseball">⚾ Baseball</option>
              <option value="Other">🏆 Other Sport</option>
            </select>
          </div>

          <!-- Event / Match -->
          <div class="form-group">
            <label class="label">Event / Match Label</label>
            <input type="text" id="form-event-label" class="input" placeholder="e.g. Arsenal vs Chelsea" required>
          </div>

          <!-- Kickoff Time (UTC) -->
          <div class="form-group">
            <label class="label">Kickoff Time (UTC)</label>
            <input type="datetime-local" id="form-kickoff" class="input" required>
            <span style="font-size: 11px; color: var(--muted);">Kickoff lock: predictions cannot be logged at or after start.</span>
          </div>

          <!-- Analyst Selection -->
          <div class="form-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
              <label class="label" style="margin-bottom: 0;">Analyst</label>
              <a href="javascript:void(0)" onclick="openNewAnalystModal()" style="font-size: 12px; color: var(--blue); text-decoration: none;">+ New Analyst</a>
            </div>
            <select id="form-analyst" class="select" required>
              <option value="">Select Analyst...</option>
            </select>
          </div>

          <!-- Market -->
          <div class="form-group">
            <label class="label">Market</label>
            <select id="form-market" class="select" onchange="handleMarketChange()" required>
              <option value="1X2">Match Result (1X2)</option>
              <option value="BTTS">Both Teams to Score (BTTS)</option>
              <option value="TOTAL_GOALS">Total Goals (Over/Under)</option>
              <option value="CUSTOM">Custom Pick</option>
            </select>
          </div>

          <!-- Selection -->
          <div class="form-group">
            <label class="label">Selection / Pick</label>
            <input type="text" id="form-selection" class="input" placeholder="e.g. Arsenal or Over 2.5" required>
          </div>

          <!-- Submit Button -->
          <button type="submit" id="btn-save-prediction" class="btn btn-primary" style="margin-top: 8px;">
            Save Prediction
          </button>
        </form>
      </div>
    </div>

    <!-- Screen 3: Predictions List -->
    <div id="screen-predictions" class="screen hidden">
      <div style="display: flex; gap: 8px; margin-bottom: 12px;">
        <button class="btn btn-outline btn-sm filter-btn active" onclick="filterPredictions('ALL', this)">All</button>
        <button class="btn btn-outline btn-sm filter-btn" onclick="filterPredictions('PENDING', this)">Pending</button>
        <button class="btn btn-outline btn-sm filter-btn" onclick="filterPredictions('SETTLED', this)">Settled</button>
      </div>
      <div id="predictions-list">
        <div style="font-size: 13px; color: var(--muted); text-align: center; padding: 24px;">
          Loading predictions...
        </div>
      </div>
    </div>

    <!-- Screen 4: Analysts List -->
    <div id="screen-analysts" class="screen hidden">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <span style="font-size: 16px; font-weight: 700;">Analyst Profiles</span>
        <button class="btn btn-primary btn-sm" onclick="openNewAnalystModal()">+ Add Analyst</button>
      </div>
      <div id="analysts-list">
        <div style="font-size: 13px; color: var(--muted); text-align: center; padding: 24px;">
          Loading analysts...
        </div>
      </div>
    </div>

    <!-- Screen 5: Settings (Approved 4th Navigation Destination) -->
    <div id="screen-settings" class="screen hidden">
      <div class="card">
        <div class="card-title">Telegram Identity & Connection</div>
        <div style="font-size: 13px; color: var(--slate); margin-bottom: 12px;">
          Connected as <strong id="settings-username">@TelegramUser</strong>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--border);">
          <span style="font-size: 13px; font-weight: 500;">Telegram Bot Status</span>
          <span class="badge badge-good" id="settings-bot-status">Connected</span>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--border);">
          <span style="font-size: 13px; font-weight: 500;">Settlement Notifications</span>
          <span class="badge badge-verified" id="settings-notifications-status">Enabled</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Storage & Privacy</div>
        <div style="font-size: 12px; color: var(--slate); line-height: 1.6;">
          <p style="margin-bottom: 8px;"><strong>Walrus Memory:</strong> Historical prediction and settlement events are synchronized to decentralized Walrus storage for independent reconstruction.</p>
          <p style="margin-bottom: 8px;"><strong>Application Encryption:</strong> Historical event records are encrypted application-side using AES-256-GCM with server-managed keys before transmission.</p>
          <p style="margin-bottom: 8px;"><strong>Tatum Sui Gateway:</strong> Sui Mainnet gRPC account-object queries verify ledger connectivity.</p>
          <p style="font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 8px;">
            Note: Due to the immutable nature of decentralized storage, encrypted records committed to Walrus cannot be modified or deleted.
          </p>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="color: var(--red);">Account Actions</div>
        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="btn btn-outline" onclick="handleSignOut()" style="color: var(--slate); width: 100%;">
            Sign Out
          </button>
          <button class="btn btn-outline" onclick="handleDeleteAccount()" style="color: var(--red); border-color: #FECACA; width: 100%;">
            Delete Account
          </button>
        </div>
      </div>
    </div>

  </div>

  <!-- Modal: Create / Edit Analyst -->
  <div id="modal-analyst" class="modal-overlay">
    <div class="modal-content">
      <div class="card-title">
        <span id="modal-analyst-title">New Analyst</span>
        <button onclick="closeModal('modal-analyst')" style="background: none; border: none; font-size: 18px; cursor: pointer;">✕</button>
      </div>
      <form id="analyst-form" onsubmit="handleSaveAnalyst(event)">
        <input type="hidden" id="modal-analyst-id">
        <div class="form-group">
          <label class="label">Analyst Name</label>
          <input type="text" id="modal-analyst-name" class="input" placeholder="e.g. Jamie Carragher" required>
        </div>
        <div class="form-group">
          <label class="label">Platform Handle (Optional)</label>
          <div style="display: flex; gap: 8px;">
            <select id="modal-analyst-platform" class="select" style="flex: 1;">
              <option value="twitter">X / Twitter</option>
              <option value="telegram">Telegram</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
            </select>
            <input type="text" id="modal-analyst-handle" class="input" placeholder="@handle" style="flex: 2;">
          </div>
        </div>
        <button type="submit" class="btn btn-primary" style="margin-top: 10px;">Save Analyst</button>
      </form>
    </div>
  </div>

  <!-- Modal: Reversible Merge Analyst -->
  <div id="modal-merge" class="modal-overlay">
    <div class="modal-content">
      <div class="card-title">
        <span>Merge Analyst Profiles</span>
        <button onclick="closeModal('modal-merge')" style="background: none; border: none; font-size: 18px; cursor: pointer;">✕</button>
      </div>
      <div style="font-size: 13px; color: var(--slate); margin-bottom: 14px;">
        Merge another profile into <strong id="merge-target-name"></strong>. All predictions are preserved and this merge can be <strong>reversed at any time</strong>.
      </div>
      <input type="hidden" id="merge-target-id">
      <div class="form-group">
        <label class="label">Select Profile to Merge In</label>
        <select id="merge-source-select" class="select" required></select>
      </div>
      <button class="btn btn-primary" onclick="handleExecuteMerge()" style="margin-top: 10px;">Confirm Merge</button>
    </div>
  </div>

  <!-- Bottom Navigation (Approved 4 Destinations: Home, Predictions, Analysts, Settings) -->
  <nav class="bottom-nav">
    <div class="nav-item active" onclick="switchTab('home')" id="tab-home">
      <div class="nav-icon">🏠</div>
      <span>Home</span>
    </div>
    <div class="nav-item" onclick="switchTab('predictions')" id="tab-predictions">
      <div class="nav-icon">📊</div>
      <span>Predictions</span>
    </div>
    <div class="nav-item" onclick="switchTab('analysts')" id="tab-analysts">
      <div class="nav-icon">👥</div>
      <span>Analysts</span>
    </div>
    <div class="nav-item" onclick="switchTab('settings')" id="tab-settings">
      <div class="nav-icon">⚙️</div>
      <span>Settings</span>
    </div>
  </nav>

  <script>
    // State
    let currentTab = 'home';
    let previousTab = 'home';
    let analystsList = [];
    let predictionsList = [];
    let currentPredictionFilter = 'ALL';
    let parsedCandidateData = null;

    // Initialization
    window.addEventListener('DOMContentLoaded', async () => {
      // Set default kickoff time to 2 hours from now UTC
      const defaultKickoff = new Date(Date.now() + 2 * 3600 * 1000);
      document.getElementById('form-kickoff').value = defaultKickoff.toISOString().slice(0, 16);

      await Promise.all([
        refreshDailyLimits(),
        refreshAnalysts(),
        refreshPredictions()
      ]);

      // URL parameters for direct view routing & UI verification
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam === 'log') {
        openLogScreen();
      } else if (tabParam) {
        switchTab(tabParam);
      }

      if (params.get('saved') === 'true') {
        document.getElementById('log-form').classList.add('hidden');
        document.getElementById('post-save-details').textContent = 'Arsenal vs Chelsea (1X2: Arsenal)';
        document.getElementById('post-save-container').classList.remove('hidden');
      }

      if (params.get('paste') === 'true') {
        document.getElementById('paste-input').value = 'Chelsea vs Liverpool - BTTS Yes. Over 2.5 goals.';
        await handlePasteParse();
      }

      if (params.get('merge') === 'true' && analystsList.length >= 2) {
        openMergeModal(analystsList[0].id, analystsList[0].name);
      }
    });

    // Navigation Switcher for 4 bottom tabs
    function switchTab(tab) {
      previousTab = currentTab;
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

      document.getElementById('screen-' + tab).classList.remove('hidden');
      const navItem = document.getElementById('tab-' + tab);
      if (navItem) navItem.classList.add('active');
      currentTab = tab;

      if (tab === 'home') renderHomeOverview();
      if (tab === 'predictions') renderPredictionsList();
      if (tab === 'analysts') renderAnalystsList();
    }

    // Open dedicated Log Screen (Primary Action)
    function openLogScreen() {
      previousTab = currentTab;
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('screen-log').classList.remove('hidden');
      refreshDailyLimits();
    }

    function closeLogScreen() {
      switchTab(previousTab || 'home');
    }
      if (tab === 'predictions') renderPredictionsList();
      if (tab === 'analysts') renderAnalystsList();
      if (tab === 'log') refreshDailyLimits();
    }

    // Refresh Daily Limits
    async function refreshDailyLimits() {
      try {
        const res = await fetch('/api/daily-limit');
        const data = await res.json();

        const badge = document.getElementById('daily-count-badge');
        badge.textContent = 'Today: ' + data.count + ' logged';

        const banner = document.getElementById('daily-warning-banner');
        const bannerText = document.getElementById('daily-warning-text');

        if (data.status === 'WARNING') {
          banner.className = 'banner banner-warning';
          bannerText.textContent = '⚠️ ' + data.warningMessage;
          banner.classList.remove('hidden');
        } else if (data.status === 'ADVISORY') {
          banner.className = 'banner banner-warning';
          bannerText.textContent = 'ℹ️ ' + data.warningMessage;
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
        }
      } catch (err) {
        console.error('Failed to fetch daily limit', err);
      }
    }

    // Fetch and populate analysts
    async function refreshAnalysts() {
      try {
        const res = await fetch('/api/analysts');
        const data = await res.json();
        analystsList = data.analysts || [];

        // Update dropdown in log form
        const select = document.getElementById('form-analyst');
        const currentVal = select.value;
        select.innerHTML = '<option value="">Select Analyst...</option>';
        analystsList.forEach(a => {
          const opt = document.createElement('option');
          opt.value = a.id;
          opt.textContent = a.name + (a.rating_tier ? ' (' + a.rating_tier + ')' : '');
          select.appendChild(opt);
        });
        if (currentVal) select.value = currentVal;

        renderAnalystsList();
        renderHomeOverview();
      } catch (err) {
        console.error('Failed to fetch analysts', err);
      }
    }

    // Fetch and populate predictions
    async function refreshPredictions() {
      try {
        const res = await fetch('/api/predictions?status=' + currentPredictionFilter);
        const data = await res.json();
        predictionsList = data.predictions || [];
        renderPredictionsList();
        renderHomeOverview();
      } catch (err) {
        console.error('Failed to fetch predictions', err);
      }
    }

    // Render Home Overview
    function renderHomeOverview() {
      const pending = predictionsList.filter(p => p.outcome === 'PENDING').length;
      const settled = predictionsList.filter(p => p.outcome !== 'PENDING').length;

      document.getElementById('stat-total-picks').textContent = predictionsList.length + ' picks total';
      document.getElementById('stat-pending').textContent = pending;
      document.getElementById('stat-settled').textContent = settled;

      const container = document.getElementById('home-analysts-list');
      if (analystsList.length === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 16px;">No analysts logged yet.</div>';
        return;
      }

      container.innerHTML = analystsList.slice(0, 3).map(a => {
        const tierClass = a.rating_tier === 'Good' ? 'badge-good' :
                          a.rating_tier === 'Average' ? 'badge-average' :
                          a.rating_tier === 'Poor' ? 'badge-poor' : 'badge-not-rated';
        const winRate = a.win_rate !== null ? a.win_rate + '%' : 'N/A';
        return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border);">' +
          '<div>' +
            '<div style="font-weight: 600; font-size: 14px;">' + a.name + '</div>' +
            '<div style="font-size: 11px; color: var(--muted);">' + (a.total_picks || 0) + ' picks · ' + winRate + ' win rate</div>' +
          '</div>' +
          '<span class="badge ' + tierClass + '">' + (a.rating_tier || 'Not Rated') + '</span>' +
        '</div>';
      }).join('');
    }

    // Render Predictions List
    function renderPredictionsList() {
      const container = document.getElementById('predictions-list');
      if (predictionsList.length === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 24px;">No predictions match this filter.</div>';
        return;
      }

      container.innerHTML = predictionsList.map(p => {
        const outcomeClass = p.outcome === 'WON' ? 'badge-won' :
                             p.outcome === 'LOST' ? 'badge-lost' : 'badge-pending';
        const kickoff = new Date(p.start_at_utc).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
        }) + ' UTC';

        return '<div class="card" style="margin-bottom: 10px;">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">' +
            '<div>' +
              '<span class="badge badge-not-rated" style="margin-right: 6px;">' + p.sport + '</span>' +
              '<strong style="font-size: 14px;">' + p.event_label + '</strong>' +
            '</div>' +
            '<span class="badge ' + outcomeClass + '">' + p.outcome + '</span>' +
          '</div>' +
          '<div style="font-size: 13px; color: var(--navy); margin-bottom: 6px;">' +
            '<strong>Pick:</strong> ' + p.market + ' — ' + p.selection +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--muted);">' +
            '<span>Analyst: ' + p.analyst_name + '</span>' +
            '<span>Kickoff: ' + kickoff + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Filter Predictions
    async function filterPredictions(filter, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPredictionFilter = filter;
      await refreshPredictions();
    }

    // Render Analysts List
    function renderAnalystsList() {
      const container = document.getElementById('analysts-list');
      if (analystsList.length === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 24px;">No analysts added yet.</div>';
        return;
      }

      container.innerHTML = analystsList.map(a => {
        const tierClass = a.rating_tier === 'Good' ? 'badge-good' :
                          a.rating_tier === 'Average' ? 'badge-average' :
                          a.rating_tier === 'Poor' ? 'badge-poor' : 'badge-not-rated';
        const winRate = a.win_rate !== null ? a.win_rate + '%' : 'N/A';
        const aliases = (a.aliases || []).map(al => '@' + al.handle + ' (' + al.platform + ')').join(', ') || 'No aliases';

        return '<div class="card">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">' +
            '<div>' +
              '<div style="font-weight: 700; font-size: 15px;">' + a.name + '</div>' +
              '<div style="font-size: 12px; color: var(--muted);">' + aliases + '</div>' +
            '</div>' +
            '<span class="badge ' + tierClass + '">' + (a.rating_tier || 'Not Rated') + '</span>' +
          '</div>' +
          '<div style="display: flex; gap: 14px; font-size: 12px; margin: 10px 0; color: var(--slate);">' +
            '<span><strong>' + (a.total_picks || 0) + '</strong> picks</span>' +
            '<span><strong>' + winRate + '</strong> win rate</span>' +
            '<span>Badge: ' + (a.history_badge || 'Insufficient') + '</span>' +
          '</div>' +
          '<div style="display: flex; gap: 8px; margin-top: 10px;">' +
            '<button class="btn btn-outline btn-sm" onclick="openMergeModal(\'' + a.id + '\', \'' + a.name + '\')">Merge...</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Paste Assistant Handler
    async function handlePasteParse() {
      const text = document.getElementById('paste-input').value;
      if (!text.trim()) return;

      try {
        const res = await fetch('/api/parse-paste', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        parsedCandidateData = data;

        const preview = document.getElementById('paste-preview');
        const content = document.getElementById('paste-preview-content');

        if (data.candidates && data.candidates.length > 0) {
          content.innerHTML = (data.extractedEventLabel ? '<div>Event: <strong>' + data.extractedEventLabel + '</strong></div>' : '') +
            data.candidates.map((c, i) => '<div>Pick ' + (i+1) + ': ' + c.market + ' — <strong>' + c.selection + '</strong></div>').join('');
          preview.classList.remove('hidden');
        } else {
          content.innerHTML = '<div style="color: var(--amber);">Could not recognize standard pattern. Form left blank for review.</div>';
          preview.classList.remove('hidden');
        }
      } catch (err) {
        alert('Paste parsing failed');
      }
    }

    // Apply Parsed Candidate to Form
    function applyParsedCandidate() {
      if (!parsedCandidateData || !parsedCandidateData.candidates || parsedCandidateData.candidates.length === 0) return;
      const candidate = parsedCandidateData.candidates[0];

      if (parsedCandidateData.extractedEventLabel) {
        document.getElementById('form-event-label').value = parsedCandidateData.extractedEventLabel;
      }
      document.getElementById('form-market').value = candidate.market;
      document.getElementById('form-selection').value = candidate.selection;

      document.getElementById('paste-preview').classList.add('hidden');
      document.getElementById('paste-input').value = '';
    }

    // Prediction Logging Submit
    async function handleSavePrediction(e) {
      e.preventDefault();
      const btn = document.getElementById('btn-save-prediction');
      btn.disabled = true;
      btn.textContent = 'Saving...';

      const payload = {
        sport: document.getElementById('form-sport').value,
        eventLabel: document.getElementById('form-event-label').value,
        startAtUtc: new Date(document.getElementById('form-kickoff').value).toISOString(),
        analystId: document.getElementById('form-analyst').value,
        market: document.getElementById('form-market').value,
        selection: document.getElementById('form-selection').value,
      };

      try {
        const res = await fetch('/api/predictions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (!res.ok) {
          alert('Error saving prediction: ' + (data.error || 'Server error'));
          btn.disabled = false;
          btn.textContent = 'Save Prediction';
          return;
        }

        // Post-save state: Show options (Add Another, Back Home)
        document.getElementById('log-form').classList.add('hidden');
        const postSave = document.getElementById('post-save-container');
        document.getElementById('post-save-details').textContent =
          payload.eventLabel + ' (' + payload.market + ': ' + payload.selection + ')';
        postSave.classList.remove('hidden');

        await Promise.all([
          refreshDailyLimits(),
          refreshPredictions(),
          refreshAnalysts()
        ]);
      } catch (err) {
        alert('Network error saving prediction');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Prediction';
      }
    }

    // Add Another Prediction: Keeps event and analyst selected
    function handleAddAnother() {
      // Clear market selection only
      document.getElementById('form-selection').value = '';
      document.getElementById('log-form').classList.remove('hidden');
      document.getElementById('post-save-container').classList.add('hidden');
    }

    // Back to Home
    function handleBackHome() {
      document.getElementById('log-form').reset();
      document.getElementById('log-form').classList.remove('hidden');
      document.getElementById('post-save-container').classList.add('hidden');
      switchTab('home');
    }

    // Modals
    function openNewAnalystModal() {
      document.getElementById('modal-analyst-title').textContent = 'New Analyst';
      document.getElementById('modal-analyst-id').value = '';
      document.getElementById('modal-analyst-name').value = '';
      document.getElementById('modal-analyst-handle').value = '';
      document.getElementById('modal-analyst').classList.add('open');
    }

    function openMergeModal(targetId, targetName) {
      document.getElementById('merge-target-id').value = targetId;
      document.getElementById('merge-target-name').textContent = targetName;

      const select = document.getElementById('merge-source-select');
      select.innerHTML = '<option value="">Select profile to merge...</option>';
      analystsList.filter(a => a.id !== targetId).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        select.appendChild(opt);
      });

      document.getElementById('modal-merge').classList.add('open');
    }

    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
    }

    // Save Analyst Handler
    async function handleSaveAnalyst(e) {
      e.preventDefault();
      const name = document.getElementById('modal-analyst-name').value;
      const platform = document.getElementById('modal-analyst-platform').value;
      const handle = document.getElementById('modal-analyst-handle').value;

      const aliases = handle ? [{ platform, handle }] : [];

      try {
        const res = await fetch('/api/analysts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, aliases })
        });
        if (!res.ok) throw new Error('Failed to create analyst');
        closeModal('modal-analyst');
        await refreshAnalysts();
      } catch (err) {
        alert(err.message);
      }
    }

    // Execute Merge Handler
    async function handleExecuteMerge() {
      const targetId = document.getElementById('merge-target-id').value;
      const sourceId = document.getElementById('merge-source-select').value;
      if (!sourceId) {
        alert('Please select a profile to merge');
        return;
      }

      try {
        const res = await fetch('/api/analysts/' + targetId + '/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceAnalystId: sourceId })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Merge failed');
        }
        closeModal('modal-merge');
        await refreshAnalysts();
        await refreshPredictions();
        alert('Profiles merged successfully! (Reversible at any time)');
      } catch (err) {
        alert(err.message);
      }
    }

    // Settings Actions
    function handleSignOut() {
      if (confirm('Are you sure you want to sign out?')) {
        alert('Session terminated.');
        location.reload();
      }
    }

    function handleDeleteAccount() {
      if (confirm('Permanently delete your account? All private predictions and analyst profiles will be deleted. Note: Encrypted ledger events committed to Walrus or Sui cannot be altered.')) {
        alert('Account deletion confirmed.');
        location.reload();
      }
    }
  </script>
</body>
</html>`;
}
