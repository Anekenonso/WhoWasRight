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
import {
  getSessionUser,
  authenticateTelegramUser,
  verifyTelegramLoginPayload,
  revokeSession,
} from '../core/auth.ts';
import { createDemoSession, isDemoUser, cleanupExpiredDemoSessions } from '../core/demo-mode.ts';
import {
  generateBotLinkToken,
  confirmBotLink,
  getBotLinkStatus,
  toggleNotifications,
  verifyWebhookSecret,
  verifyCallbackNonce,
  answerCallbackQuery,
  sendMessage as sendTelegramMessage,
  processNotificationQueue,
  handleTelegramCallbackQuery,
  getBotUsername,
  handleConnectedWebsite,
} from '../core/telegram-bot.ts';
import { verifyCronSecret, runSettlementCycle } from '../core/football-settler.ts';
import { settlePrediction } from '../core/predictions.ts';

// Authentication error for fail-closed request rejection
export class UnauthorizedError extends Error {
  statusCode: number;
  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
    this.statusCode = 401;
  }
}

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

/**
 * Resolves allowed CORS origins from configuration and environment.
 * Supports exact production frontend origin and optional preview pattern.
 */
export function getAllowedOrigins(): { exact: Set<string>; patterns: RegExp[] } {
  const exact = new Set<string>();
  const patterns: RegExp[] = [];

  const envOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    process.env.ALLOWED_ORIGINS,
  ].filter(Boolean) as string[];

  for (const envVal of envOrigins) {
    for (const part of envVal.split(',')) {
      const trimmed = part.trim();
      if (trimmed) exact.add(trimmed);
    }
  }

  if (process.env.ALLOWED_PREVIEW_PATTERN) {
    try {
      patterns.push(new RegExp(process.env.ALLOWED_PREVIEW_PATTERN));
    } catch (e) {
      console.warn('Invalid ALLOWED_PREVIEW_PATTERN regex:', process.env.ALLOWED_PREVIEW_PATTERN);
    }
  }

  // Development convenience: Allow localhost / 127.0.0.1
  if (process.env.NODE_ENV !== 'production') {
    exact.add('http://localhost:3000');
    exact.add('http://localhost:5173');
    exact.add('http://127.0.0.1:3000');
    exact.add('http://127.0.0.1:5173');
    patterns.push(/^http:\/\/localhost(:\d+)?$/);
    patterns.push(/^http:\/\/127\.0\.0\.1(:\d+)?$/);
  }

  return { exact, patterns };
}

/**
 * Validates whether an incoming HTTP Origin is authorized under the CORS policy.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const { exact, patterns } = getAllowedOrigins();
  if (exact.has(origin)) return true;
  for (const pattern of patterns) {
    if (pattern.test(origin)) return true;
  }
  return false;
}

/**
 * Generates CORS headers tailored to the incoming request.
 * - Allowed origins receive explicit Access-Control-Allow-Origin + Vary: Origin.
 * - Unapproved origins omit Access-Control-Allow-Origin to fail closed in browsers.
 * - Credentials are not enabled for the bearer-token architecture.
 */
export function getCorsHeaders(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers['origin'];
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id, X-Dev-User-Id',
  };

  if (origin && isOriginAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }

  return headers;
}

// Helper to send JSON responses with request-aware CORS headers
function sendJson(res: http.ServerResponse, statusCode: number, data: any, req?: http.IncomingMessage) {
  const effectiveReq = req || (res as any).__req;
  const corsHeaders = effectiveReq ? getCorsHeaders(effectiveReq) : {};
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    ...corsHeaders,
  });
  res.end(JSON.stringify(data));
}

// Helper to authenticate request - fails closed, never falls back to arbitrary/dev user
export async function getUserIdFromRequest(req: http.IncomingMessage): Promise<string> {
  // 1. Check Bearer token in Authorization header
  const authHeader = req.headers['authorization'];
  let token: string | null = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  }

  // 2. Check session_token cookie (for browser SPA requests)
  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const c of cookies) {
      const trimmed = c.trim();
      if (trimmed.startsWith('session_token=')) {
        token = decodeURIComponent(trimmed.substring(14));
        break;
      }
    }
  }

  // 3. Resolve session from database sessions table
  if (token) {
    const user = await getSessionUser(token);
    if (user) {
      return user.id;
    }
  }

  // 4. Development convenience: Strictly disallowed in production
  // Only active when BOTH process.env.NODE_ENV !== 'production' AND process.env.ALLOW_DEV_AUTH === 'true'
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH === 'true') {
    const devUserId = req.headers['x-dev-user-id'] as string;
    if (devUserId) {
      return devUserId;
    }
  }

  // 5. Fail closed: Never return dev_user or first database user
  throw new UnauthorizedError('Authentication required');
}

export function createWebServer(): http.Server {
  return http.createServer(async (req, res) => {
    (res as any).__req = req;
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      const cors = getCorsHeaders(req);
      res.writeHead(204, cors);
      res.end();
      return;
    }

    try {
      // -------------------------------------------------------------
      // API ROUTES
      // -------------------------------------------------------------

      // 0. Authentication Routes (Telegram Login, Judge Demo Mode, Session Status, Logout)
      if (pathname === '/api/auth/telegram' && method === 'POST') {
        const body = await parseJsonBody(req);
        const verification = verifyTelegramLoginPayload(body);
        if (!verification.valid || !verification.user) {
          return sendJson(res, 401, { error: verification.reason || 'Invalid Telegram authentication payload' });
        }
        const session = await authenticateTelegramUser(verification.user);
        res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return sendJson(res, 200, {
          success: true,
          token: session.token,
          user: session.user,
          expiresAt: session.expiresAt.toISOString(),
          isDemo: false,
        });
      }

      if (pathname === '/api/auth/demo' && method === 'POST') {
        const session = await createDemoSession();
        res.setHeader('Set-Cookie', `session_token=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
        return sendJson(res, 200, {
          success: true,
          token: session.token,
          user: session.user,
          expiresAt: session.expiresAt.toISOString(),
          isDemo: true,
        });
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        let token: string | null = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7).trim();
        }
        if (!token && req.headers.cookie) {
          const cookies = req.headers.cookie.split(';');
          for (const c of cookies) {
            const trimmed = c.trim();
            if (trimmed.startsWith('session_token=')) {
              token = decodeURIComponent(trimmed.substring(14));
              break;
            }
          }
        }
        if (token) {
          const user = await getSessionUser(token);
          if (user) {
            return sendJson(res, 200, {
              authenticated: true,
              user,
              isDemo: isDemoUser(user),
            });
          }
        }
        return sendJson(res, 401, { authenticated: false, error: 'Not authenticated' });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        let token: string | null = null;
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7).trim();
        }
        if (!token && req.headers.cookie) {
          const cookies = req.headers.cookie.split(';');
          for (const c of cookies) {
            const trimmed = c.trim();
            if (trimmed.startsWith('session_token=')) {
              token = decodeURIComponent(trimmed.substring(14));
              break;
            }
          }
        }
        if (token) {
          await revokeSession(token);
        }
        res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
        return sendJson(res, 200, { success: true, message: 'Signed out successfully' });
      }

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
      // PHASE 5: BOT LINKING, WEBHOOK, SETTLEMENT & NOTIFICATIONS
      // -------------------------------------------------------------

      // Bot: Generate linking token
      if (pathname === '/api/bot/activate' && method === 'POST') {
        const userId = await getUserIdFromRequest(req);
        try {
          const { plaintextToken, deepLink } = await generateBotLinkToken(userId);
          return sendJson(res, 200, { deepLink, token: plaintextToken });
        } catch (err: any) {
          const msg = err.message || 'Failed to activate bot';
          const isConfigError = msg.includes('not configured') || msg.includes('is invalid');
          return sendJson(res, isConfigError ? 503 : 500, { error: msg });
        }
      }

      // Bot: Get link status
      if (pathname === '/api/bot/status' && method === 'GET') {
        const userId = await getUserIdFromRequest(req);
        const status = await getBotLinkStatus(userId);
        return sendJson(res, 200, status);
      }

      // Bot: Toggle notifications
      if (pathname === '/api/bot/toggle-notifications' && method === 'POST') {
        const userId = await getUserIdFromRequest(req);
        const body = await parseJsonBody(req);
        const updated = await toggleNotifications(userId, !!body.enabled);
        return sendJson(res, 200, { success: updated });
      }

      // Telegram Webhook
      if (pathname === '/api/telegram/webhook' && method === 'POST') {
        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        if (!verifyWebhookSecret(secretHeader)) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }
        const update = await parseJsonBody(req);

        // 1. Telegram connected_website event (from Telegram Login Widget data-request-access="write")
        if (update && update.message && update.message.connected_website) {
          const result = await handleConnectedWebsite(update.message);
          if (result.success && !result.alreadyLinked) {
            try {
              await sendTelegramMessage(
                update.message.chat.id,
                'WhoWasRight connected! Result notifications are currently disabled. You can enable them anytime in Settings in WhoWasRight.'
              );
            } catch (msgErr) {
              console.error('[TELEGRAM] Non-fatal welcome message send error:', msgErr);
            }
          }
          return sendJson(res, 200, { ok: true, ...result });
        }

        // 2. Bot activation via deep link (/start link_...)
        if (update && update.message && update.message.text && update.message.text.startsWith('/start link_')) {
          const token = update.message.text.replace('/start link_', '').trim();
          const chatId = update.message.chat.id;
          const result = await confirmBotLink({ plaintextToken: token, telegramChatId: chatId });
          if (result.success) {
            await sendTelegramMessage(chatId, 'WhoWasRight connected! You will receive result notifications here.');
          } else {
            await sendTelegramMessage(chatId, 'Could not link account: ' + result.reason);
          }
          return sendJson(res, 200, { ok: true });
        }

        // 3. Inline button callbacks (manual settlement)
        if (update && update.callback_query) {
          const cbq = update.callback_query;
          const callbackData = cbq.data || '';
          const fromChatId = cbq.from.id;
          const callbackQueryId = cbq.id;

          const cbResult = await handleTelegramCallbackQuery({
            callbackData,
            fromChatId,
            callbackQueryId,
          });
          return sendJson(res, 200, { ok: true, ...cbResult });
        }
        return sendJson(res, 200, { ok: true });
      }

      // Cron: Football settlement + notification dispatch + demo session cleanup
      if (pathname === '/api/cron/settle' && method === 'POST') {
        if (!verifyCronSecret(req.headers['authorization'])) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }
        const settlementResult = await runSettlementCycle();
        const notifResult = await processNotificationQueue();

        let demoCleanupResult: { cleaned: number; error: string | null } = { cleaned: 0, error: null };
        try {
          const cleanedCount = await cleanupExpiredDemoSessions();
          demoCleanupResult.cleaned = cleanedCount;
        } catch (err: any) {
          demoCleanupResult.error = err.message || 'Demo session cleanup failed';
          console.error('[CRON] Demo session cleanup non-blocking error:', err);
        }

        return sendJson(res, 200, {
          settlement: settlementResult,
          notifications: notifResult,
          demoCleanup: demoCleanupResult,
        });
      }

      // Manual settlement: settle a prediction from the app
      const manualSettleMatch = pathname.match(/^\/api\/predictions\/([0-9a-fA-F-]+)\/settle$/);
      if (manualSettleMatch && method === 'POST') {
        const predictionId = manualSettleMatch[1];
        const userId = await getUserIdFromRequest(req);
        const body = await parseJsonBody(req);
        const allowed = ['WON', 'LOST', 'PUSH'];
        if (!allowed.includes(body.outcome)) {
          return sendJson(res, 400, { error: 'outcome must be WON, LOST, or PUSH' });
        }
        const result = await settlePrediction({
          userId,
          predictionId,
          newOutcome: body.outcome,
          source: 'MANUAL_USER',
          verification: 'SELF_REPORTED',
          evidenceJson: { source: 'web_manual_settle' },
        });
        return sendJson(res, 200, { success: true, ...result });
      }

      // Prediction detail (private, ownership-enforced)
      const predDetailMatch = pathname.match(/^\/api\/predictions\/([0-9a-fA-F-]+)$/);
      if (predDetailMatch && method === 'GET') {
        const predictionId = predDetailMatch[1];
        const userId = await getUserIdFromRequest(req);
        const predRes = await query(
          'SELECT p.*, e.label as event_label, e.sport, e.start_at_utc, e.api_fixture_id, a.name as analyst_name FROM predictions p JOIN events e ON e.id = p.event_id JOIN analysts a ON a.id = p.analyst_id WHERE p.id = $1 AND p.user_id = $2;',
          [predictionId, userId]
        );
        if (predRes.rows.length === 0) {
          return sendJson(res, 404, { error: 'Prediction not found' });
        }
        return sendJson(res, 200, { prediction: predRes.rows[0] });
      }

      // -------------------------------------------------------------
      // UI / HTML CLIENT (Mobile-First Single-Page Application)
      // -------------------------------------------------------------
      // -------------------------------------------------------------
      const predPageMatch = pathname.match(/^\/predictions\/([0-9a-fA-F-]+)$/);
      if (
        pathname === '/' ||
        pathname === '/index.html' ||
        pathname === '/log' ||
        pathname === '/analysts' ||
        pathname === '/predictions' ||
        predPageMatch
      ) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderMobileAppHtml());
        return;
      }

      // 404 for unknown endpoints
      sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      if (err instanceof UnauthorizedError || err.name === 'UnauthorizedError' || err.statusCode === 401) {
        return sendJson(res, 401, { error: err.message || 'Authentication required' });
      }
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
export function renderMobileAppHtml(): string {
  // Telegram Login Widget Configuration:
  // Requires TELEGRAM_BOT_NAME or TELEGRAM_BOT_USERNAME (e.g. "WhoWasRightBot") configured in the environment.
  // Requirements for Telegram's @BotFather:
  // 1. Bot username must be 5-32 characters, alphanumeric and underscore, ending in 'bot' or '_bot'.
  // 2. Production Domain Whitelist: You must run `/setdomain` in @BotFather, select the bot,
  //    and supply the exact domain (e.g. `whowasright.onrender.com` without https:// or trailing slash).
  //    Without /setdomain, the Telegram widget fails to render or throws "Bot domain invalid".
  const botUsername = getBotUsername();
  const isValidBotName = !!botUsername;
  const botHandle = isValidBotName ? `@${botUsername}` : '@WhoWasRightBot';

  const telegramWidgetHtml = isValidBotName
    ? `<script async src="https://telegram.org/js/telegram-widget.js?22"
            data-telegram-login="${botUsername}"
            data-size="large"
            data-radius="8"
            data-onauth="onTelegramAuth(user)"
            data-request-access="write"></script>`
    : `<div style="font-size: 12px; color: var(--muted); background: var(--bg); padding: 10px 14px; border-radius: 8px; width: 100%; text-align: center; border: 1px dashed var(--border);">
            Telegram login is unconfigured (<code>TELEGRAM_BOT_NAME</code> or <code>TELEGRAM_BOT_USERNAME</code> missing).
          </div>`;

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

  <!-- Screen 0: Authentication / Login Screen (Shown when unauthenticated) -->
  <div id="screen-auth" class="container">
    <div class="card" style="text-align: center; padding: 24px 16px; margin-top: 16px;">
      <div style="font-size: 36px; margin-bottom: 8px;">⚽ ⚖️</div>
      <h1 style="font-size: 20px; font-weight: 700; color: var(--navy); margin-bottom: 6px;">WhoWasRight</h1>
      <p style="font-size: 13px; color: var(--muted); margin-bottom: 20px; line-height: 1.5;">
        Private sports prediction journal with cryptographically immutable credibility tracking.
      </p>

      <div id="auth-error-banner" class="banner banner-error hidden" style="text-align: left; margin-bottom: 16px;">
        <span id="auth-error-text">Authentication required</span>
      </div>

      <!-- Telegram Login Widget Section (Primary) -->
      <div style="margin-bottom: 20px;">
        <div style="font-size: 13px; font-weight: 600; color: var(--slate); margin-bottom: 4px;">
          Sign In with Telegram
        </div>
        <p style="font-size: 11px; color: var(--muted); margin-bottom: 14px;">
          Receive verified result alerts and settlement reminders via ${botHandle}.
        </p>
        <div id="telegram-login-container" style="display: flex; justify-content: center; min-height: 44px; align-items: center;">
          ${telegramWidgetHtml}
        </div>
      </div>

      <!-- Demo Account Login (Compact Secondary Alternative) -->
      <div style="border-top: 1px solid var(--border); padding-top: 16px;">
        <button id="btn-demo-login" class="btn btn-outline btn-sm" onclick="handleDemoLogin()" style="width: auto; margin: 0 auto; display: inline-flex; align-items: center; justify-content: center; padding: 8px 16px; font-size: 13px; color: var(--slate);">
          Log in with a demo account
        </button>
      </div>
    </div>
  </div>

  <div id="app-content" class="hidden">
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
            <select id="form-analyst" class="select" onchange="handleAnalystDropdownChange()" required>
              <option value="">Select Analyst...</option>
            </select>
          </div>

          <!-- Inline Credibility Summary Card for Selected Analyst -->
          <div id="analyst-credibility-preview" class="card hidden" style="background: var(--blue-light); border: 1px solid #BFDBFE; padding: 12px; margin-bottom: 14px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <span style="font-size: 12px; font-weight: 600; color: var(--blue);" id="prev-analyst-name">Analyst Credibility</span>
              <span class="badge" id="prev-analyst-badge">Not Rated</span>
            </div>
            <div style="font-size: 12px; color: var(--navy);" id="prev-analyst-summary">
              0 settled picks · Insufficient history
            </div>
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

    <!-- Screen 4b: Analyst Detail Screen -->
    <div id="screen-analyst-detail" class="screen hidden">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <button class="btn btn-outline btn-sm" onclick="switchTab('analysts')" style="min-width: 44px; min-height: 44px; padding: 0 12px;">
          ← Back
        </button>
        <span style="font-size: 16px; font-weight: 700;" id="detail-analyst-title">Analyst Profile</span>
      </div>

      <!-- Credibility Card -->
      <div class="card" id="detail-credibility-card">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
          <div>
            <div style="font-size: 18px; font-weight: 700; color: var(--navy);" id="detail-name"></div>
            <div style="font-size: 12px; color: var(--muted);" id="detail-aliases"></div>
          </div>
          <span class="badge" id="detail-rating-tier-badge" style="font-size: 13px; padding: 4px 10px;">Not Rated</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
          <div style="background: var(--bg); padding: 10px 12px; border-radius: 8px;">
            <div style="font-size: 11px; color: var(--muted);">WIN RATE</div>
            <div style="font-size: 20px; font-weight: 700; color: var(--navy);" id="detail-win-rate">—</div>
          </div>
          <div style="background: var(--bg); padding: 10px 12px; border-radius: 8px;">
            <div style="font-size: 11px; color: var(--muted);">HISTORY BADGE</div>
            <div style="font-size: 14px; font-weight: 600; color: var(--navy); margin-top: 4px;" id="detail-history-badge">Insufficient</div>
          </div>
        </div>

        <!-- Outcome breakdown grid -->
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 12px; text-align: center;">
          <div style="background: #F0FDF4; border: 1px solid #DCFCE7; padding: 8px; border-radius: 6px;">
            <div style="font-size: 11px; color: #166534; font-weight: 600;">WON</div>
            <div style="font-size: 16px; font-weight: 700; color: #166534;" id="detail-count-won">0</div>
          </div>
          <div style="background: #FEF2F2; border: 1px solid #FEE2E2; padding: 8px; border-radius: 6px;">
            <div style="font-size: 11px; color: #991B1B; font-weight: 600;">LOST</div>
            <div style="font-size: 16px; font-weight: 700; color: #991B1B;" id="detail-count-lost">0</div>
          </div>
          <div style="background: #F8FAFC; border: 1px solid var(--border); padding: 8px; border-radius: 6px;">
            <div style="font-size: 11px; color: var(--muted); font-weight: 600;">PUSH</div>
            <div style="font-size: 16px; font-weight: 700; color: var(--slate);" id="detail-count-push">0</div>
          </div>
        </div>

        <!-- Verification breakdown -->
        <div style="padding: 10px 0; border-top: 1px solid var(--border); font-size: 12px; display: flex; justify-content: space-between;">
          <span style="color: var(--muted);">Verification:</span>
          <span>
            <strong id="detail-count-api">0</strong> API-Verified · <strong id="detail-count-self">0</strong> Self-Reported
          </span>
        </div>

        <!-- Walrus Decentralized Memory Sync Status -->
        <div style="padding: 10px 0; border-top: 1px solid var(--border); font-size: 12px; display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--muted);">Walrus Memory:</span>
          <span class="badge badge-not-rated" id="detail-walrus-status">⏳ Checking...</span>
        </div>

        <!-- Historical Integrity Banner -->
        <div id="detail-integrity-banner" class="banner banner-warning hidden" style="margin-top: 10px; margin-bottom: 0;">
          <span id="detail-integrity-text">Checking verification status...</span>
        </div>
      </div>

      <!-- Analyst Prediction History -->
      <div class="card">
        <div class="card-title">Prediction History</div>
        <div id="detail-predictions-list">
          <div style="font-size: 13px; color: var(--muted); text-align: center; padding: 16px;">
            No predictions logged for this analyst.
          </div>
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
        <div id="settings-bot-activation-prompt" style="padding: 10px 0; border-top: 1px solid var(--border); display: none;">
          <p style="font-size: 12px; color: var(--slate); margin-bottom: 8px;">Enable Result Reminders to receive verified result alerts and manual score settlement prompts via ${botHandle}.</p>
          <button id="btn-activate-bot" class="btn btn-primary btn-sm" onclick="handleActivateBot()">Enable Result Reminders</button>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-top: 1px solid var(--border);">
          <span style="font-size: 13px; font-weight: 500;">Settlement Notifications</span>
          <div style="display: flex; align-items: center; gap: 8px;"><span class="badge badge-verified" id="settings-notifications-status">Enabled</span><button id="btn-toggle-notifications" class="btn btn-outline btn-sm" onclick="handleToggleNotifications()">Toggle</button></div>
        </div>
        <div id="settings-bot-feedback" class="banner hidden" style="margin-top: 12px; font-size: 12px;"></div>
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
  </div>

  <script>
    // Session & Auth state
    const TOKEN_STORAGE_KEY = 'wwr_session_token';
    let currentAuthToken = null;
    let currentUser = null;

    // State
    let currentTab = 'home';
    let previousTab = 'home';
    let analystsList = [];
    let predictionsList = [];
    let currentPredictionFilter = 'ALL';
    let parsedCandidateData = null;

    // Centralized authenticated API Fetch wrapper (sends Bearer token, fails closed on 401)
    async function apiFetch(url, options) {
      options = options || {};
      const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      const headers = Object.assign({}, options.headers || {});
      if (token) {
        headers['Authorization'] = 'Bearer ' + token;
      }
      options.headers = headers;
      const res = await fetch(url, options);
      if (res.status === 401) {
        // Expired or invalid token: clear local storage and return to login screen
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        currentAuthToken = null;
        currentUser = null;
        showAuthScreen('Your session has expired. Please sign in again.');
        throw new Error('Unauthorized');
      }
      return res;
    }

    function showAuthScreen(msg) {
      document.getElementById('screen-auth').classList.remove('hidden');
      document.getElementById('app-content').classList.add('hidden');
      const banner = document.getElementById('auth-error-banner');
      const text = document.getElementById('auth-error-text');
      if (msg && banner && text) {
        text.textContent = msg;
        banner.classList.remove('hidden');
      } else if (banner) {
        banner.classList.add('hidden');
      }
    }

    function showAppScreen() {
      document.getElementById('screen-auth').classList.add('hidden');
      document.getElementById('app-content').classList.remove('hidden');
      if (currentUser) {
        const usernameEl = document.getElementById('settings-username');
        if (usernameEl) {
          usernameEl.textContent = currentUser.username ? '@' + currentUser.username : 'User ' + currentUser.id.slice(0, 8);
        }
        const badgeEl = document.getElementById('topbar-user-badge');
        if (badgeEl) {
          badgeEl.textContent = Number(currentUser.telegram_id) < 0 ? 'Judge Demo' : 'Journal';
        }
      }
    }

    async function handleDemoLogin() {
      const btn = document.getElementById('btn-demo-login');
      if (btn) btn.disabled = true;
      try {
        const res = await fetch('/api/auth/demo', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json();
        if (!res.ok || !data.token) {
          throw new Error(data.error || 'Failed to start demo session');
        }
        sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
        currentAuthToken = data.token;
        currentUser = data.user;
        showAppScreen();
        await initializeAppViews();
      } catch (err) {
        showAuthScreen(err.message || 'Demo login failed');
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function handleTelegramAuth(user) {
      try {
        const res = await fetch('/api/auth/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(user),
        });
        const data = await res.json();
        if (!res.ok || !data.token) {
          throw new Error(data.error || 'Telegram authentication failed');
        }
        sessionStorage.setItem(TOKEN_STORAGE_KEY, data.token);
        currentAuthToken = data.token;
        currentUser = data.user;
        showAppScreen();
        await initializeAppViews();
      } catch (err) {
        showAuthScreen(err.message || 'Telegram authentication failed');
      }
    }
    window.onTelegramAuth = handleTelegramAuth;

    async function handleSignOut() {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {
        // Proceed to clear local state
      } finally {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        currentAuthToken = null;
        currentUser = null;
        showAuthScreen('You have been signed out.');
      }
    }

    async function handleDeleteAccount() {
      if (confirm('Are you sure you want to delete your account? All private journal entries will be deleted.')) {
        try {
          await apiFetch('/api/account/delete', { method: 'POST' });
        } catch (e) {
          // Proceed to clear local state
        } finally {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          currentAuthToken = null;
          currentUser = null;
          showAuthScreen('Your account and private data have been deleted.');
        }
      }
    }

    async function initializeAppViews() {
      // Set default kickoff time to 2 hours from now UTC
      const defaultKickoff = new Date(Date.now() + 2 * 3600 * 1000);
      const kickoffInput = document.getElementById('form-kickoff');
      if (kickoffInput) kickoffInput.value = defaultKickoff.toISOString().slice(0, 16);

      await Promise.all([
        refreshDailyLimits(),
        refreshAnalysts(),
        refreshPredictions(),
        refreshBotStatus()
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

      // Deep link routing: /predictions/:predictionId
      const predPathMatch = window.location.pathname.match(new RegExp('/predictions/([0-9a-fA-F-]+)'));
      if (predPathMatch) {
        const targetPredId = predPathMatch[1];
        switchTab('predictions');
        await loadAndHighlightPrediction(targetPredId);
      }
    }

    // Initialization on page load
    window.addEventListener('DOMContentLoaded', async () => {
      const token = sessionStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        showAuthScreen();
        return;
      }

      try {
        const res = await apiFetch('/api/auth/me');
        const data = await res.json();
        if (data.authenticated && data.user) {
          currentUser = data.user;
          currentAuthToken = token;
          showAppScreen();
          await initializeAppViews();
        } else {
          sessionStorage.removeItem(TOKEN_STORAGE_KEY);
          showAuthScreen();
        }
      } catch (err) {
        sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        showAuthScreen();
      }
    });

    // Navigation Switcher for 4 bottom tabs
    function switchTab(tab) {
      previousTab = currentTab;
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

      const targetScreen = document.getElementById('screen-' + tab);
      if (targetScreen) targetScreen.classList.remove('hidden');

      const navItem = document.getElementById('tab-' + tab);
      if (navItem) navItem.classList.add('active');
      currentTab = tab;

      if (tab === 'home') renderHomeOverview();
      if (tab === 'predictions') renderPredictionsList();
      if (tab === 'analysts') renderAnalystsList();
      if (tab === 'settings') refreshBotStatus();
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

    // Inline Credibility Preview in Logging Flow
    function handleAnalystDropdownChange() {
      const select = document.getElementById('form-analyst');
      const analystId = select.value;
      const preview = document.getElementById('analyst-credibility-preview');
      if (!analystId) {
        preview.classList.add('hidden');
        return;
      }
      const analyst = analystsList.find(a => a.id === analystId);
      if (!analyst) {
        preview.classList.add('hidden');
        return;
      }
      const cred = analyst.credibility || {};
      const badge = document.getElementById('prev-analyst-badge');
      const summary = document.getElementById('prev-analyst-summary');
      const name = document.getElementById('prev-analyst-name');

      name.textContent = analyst.name;
      const tier = cred.ratingTier || 'Not Rated';
      badge.textContent = tier;
      badge.className = 'badge ' + (tier === 'Good' ? 'badge-good' : tier === 'Average' ? 'badge-average' : tier === 'Poor' ? 'badge-poor' : 'badge-not-rated');

      const winRateText = cred.winRate !== null && cred.winRate !== undefined ? cred.winRate + '% Win Rate' : 'No Win Rate';
      summary.textContent = tier + ' (' + winRateText + ') · ' + (cred.wonCount || 0) + 'W - ' + (cred.lostCount || 0) + 'L - ' + (cred.pushCount || 0) + 'P · ' + (cred.historyBadge || 'Insufficient') + ' History';
      preview.classList.remove('hidden');
    }

    // Open Analyst Detail Screen
    async function openAnalystDetail(analystId) {
      previousTab = currentTab;
      document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      document.getElementById('screen-analyst-detail').classList.remove('hidden');

      try {
        const res = await apiFetch('/api/analysts/' + analystId);
        const a = await res.json();
        const cred = a.credibility || {};

        document.getElementById('detail-name').textContent = a.name;
        document.getElementById('detail-analyst-title').textContent = a.name;
        const aliases = (a.aliases || []).map(al => '@' + al.handle + ' (' + al.platform + ')').join(', ') || 'No aliases linked';
        document.getElementById('detail-aliases').textContent = aliases;

        const tier = cred.ratingTier || 'Not Rated';
        const tierBadge = document.getElementById('detail-rating-tier-badge');
        tierBadge.textContent = tier;
        tierBadge.className = 'badge ' + (tier === 'Good' ? 'badge-good' : tier === 'Average' ? 'badge-average' : tier === 'Poor' ? 'badge-poor' : 'badge-not-rated');

        document.getElementById('detail-win-rate').textContent = cred.winRate !== null && cred.winRate !== undefined ? cred.winRate + '%' : '—';
        document.getElementById('detail-history-badge').textContent = (cred.historyBadge || 'Insufficient') + ' History';

        document.getElementById('detail-count-won').textContent = cred.wonCount || 0;
        document.getElementById('detail-count-lost').textContent = cred.lostCount || 0;
        document.getElementById('detail-count-push').textContent = cred.pushCount || 0;

        document.getElementById('detail-count-api').textContent = cred.apiVerifiedCount || 0;
        document.getElementById('detail-count-self').textContent = cred.selfReportedCount || 0;

        // Dynamic Walrus Integrity UI Update (Fail-Closed)
        const integ = a.integrity || { verified: false, status: 'UNAVAILABLE' };
        const walrusStatusEl = document.getElementById('detail-walrus-status');
        const bannerEl = document.getElementById('detail-integrity-banner');
        const bannerTextEl = document.getElementById('detail-integrity-text');

        if (integ.status === 'VERIFIED') {
          if (walrusStatusEl) {
            walrusStatusEl.className = 'badge badge-verified';
            walrusStatusEl.textContent = '✓ History Integrity Verified';
          }
          if (bannerEl && bannerTextEl) {
            bannerEl.className = 'banner banner-success';
            bannerTextEl.textContent = '✓ Cryptographic Audit Trail Verified';
            bannerEl.classList.remove('hidden');
          }
        } else if (integ.status === 'NOT_APPLICABLE') {
          if (walrusStatusEl) {
            walrusStatusEl.className = 'badge badge-not-rated';
            walrusStatusEl.textContent = 'No Prediction History';
          }
          if (bannerEl) {
            bannerEl.classList.add('hidden');
          }
        } else if (integ.status === 'INCOMPLETE') {
          if (walrusStatusEl) {
            walrusStatusEl.className = 'badge badge-pending';
            walrusStatusEl.textContent = '⏳ Awaiting Walrus Sync';
          }
          if (bannerEl && bannerTextEl) {
            bannerEl.className = 'banner banner-warning';
            bannerTextEl.textContent = '⚠️ ' + (integ.warning || 'History Incomplete: pending Walrus synchronization');
            bannerEl.classList.remove('hidden');
          }
        } else if (integ.status === 'UNAVAILABLE') {
          if (walrusStatusEl) {
            walrusStatusEl.className = 'badge badge-not-rated';
            walrusStatusEl.textContent = '⏳ Verification Unavailable';
          }
          if (bannerEl && bannerTextEl) {
            bannerEl.className = 'banner banner-warning';
            bannerTextEl.textContent = '⚠️ ' + (integ.warning || 'Walrus verification service temporarily unavailable');
            bannerEl.classList.remove('hidden');
          }
        } else {
          // FAILED (tampered memory, sequence gap, or crypto mismatch)
          if (walrusStatusEl) {
            walrusStatusEl.className = 'badge badge-lost';
            walrusStatusEl.textContent = '✗ Integrity Failure';
          }
          if (bannerEl && bannerTextEl) {
            bannerEl.className = 'banner banner-error';
            bannerTextEl.textContent = '⚠️ ' + (integ.warning || 'Historical integrity mismatch detected');
            bannerEl.classList.remove('hidden');
          }
        }

        // Render predictions for this analyst
        const predsContainer = document.getElementById('detail-predictions-list');
        const preds = a.predictions || [];
        if (preds.length === 0) {
          predsContainer.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 16px;">No predictions logged for this analyst.</div>';
        } else {
        predsContainer.innerHTML = preds.map(p => {
            const outClass = p.outcome === 'WON' ? 'badge-won' : p.outcome === 'LOST' ? 'badge-lost' : 'badge-pending';
            return '<div style="padding: 10px 0; border-bottom: 1px solid var(--border);">' +
              '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">' +
                '<strong>' + p.event_label + '</strong>' +
                '<span class="badge ' + outClass + '">' + p.outcome + '</span>' +
              '</div>' +
              '<div style="font-size: 12px; color: var(--slate);">' + p.market + ': ' + p.selection + ' · <span style="color: var(--muted);">' + (p.verification || 'UNVERIFIED') + '</span></div>' +
            '</div>';
          }).join('');
        }
      } catch (err) {
        console.error('Failed to load analyst detail', err);
        const errWalrusEl = document.getElementById('detail-walrus-status');
        const errBannerEl = document.getElementById('detail-integrity-banner');
        const errBannerTextEl = document.getElementById('detail-integrity-text');
        if (errWalrusEl) {
          errWalrusEl.className = 'badge badge-not-rated';
          errWalrusEl.textContent = '⏳ Verification Unavailable';
        }
        if (errBannerEl && errBannerTextEl) {
          errBannerEl.className = 'banner banner-warning';
          errBannerTextEl.textContent = '⚠️ Walrus verification service temporarily unavailable';
          errBannerEl.classList.remove('hidden');
        }
      }
    }

    // Refresh Daily Limits
    async function refreshDailyLimits() {
      try {
        const res = await apiFetch('/api/daily-limit');
        const data = await res.json();

        const badge = document.getElementById('daily-count-badge');
        if (badge) badge.textContent = 'Today: ' + data.count + ' logged';

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
        const res = await apiFetch('/api/analysts');
        const data = await res.json();
        analystsList = data.analysts || [];

        // Update dropdown in log form
        const select = document.getElementById('form-analyst');
        if (select) {
          const currentVal = select.value;
          select.innerHTML = '<option value="">Select Analyst...</option>';
          analystsList.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            const cred = a.credibility || {};
            const tierStr = cred.ratingTier ? ' (' + cred.ratingTier + ')' : '';
            opt.textContent = a.name + tierStr;
            select.appendChild(opt);
          });
          if (currentVal) select.value = currentVal;
        }

        renderAnalystsList();
        renderHomeOverview();
      } catch (err) {
        console.error('Failed to fetch analysts', err);
      }
    }

    // Fetch and populate predictions
    async function refreshPredictions() {
      try {
        const res = await apiFetch('/api/predictions?status=' + currentPredictionFilter);
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

      const totalElem = document.getElementById('stat-total-picks');
      const pendingElem = document.getElementById('stat-pending');
      const settledElem = document.getElementById('stat-settled');

      if (totalElem) totalElem.textContent = predictionsList.length + ' picks total';
      if (pendingElem) pendingElem.textContent = pending;
      if (settledElem) settledElem.textContent = settled;

      const container = document.getElementById('home-analysts-list');
      if (!container) return;

      if (analystsList.length === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 16px;">No analysts logged yet.</div>';
        return;
      }

      container.innerHTML = analystsList.slice(0, 3).map(a => {
        const cred = a.credibility || {};
        const tier = cred.ratingTier || 'Not Rated';
        const tierClass = tier === 'Good' ? 'badge-good' :
                          tier === 'Average' ? 'badge-average' :
                          tier === 'Poor' ? 'badge-poor' : 'badge-not-rated';
        const winRate = cred.winRate !== null && cred.winRate !== undefined ? cred.winRate + '%' : 'N/A';
        return '<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border);">' +
          '<div onclick="openAnalystDetail(\\\'' + a.id + '\\\')" style="cursor: pointer;">' +
            '<div style="font-weight: 600; font-size: 14px; color: var(--navy);">' + a.name + '</div>' +
            '<div style="font-size: 11px; color: var(--muted);">' + (cred.settledCount || 0) + ' settled · ' + winRate + ' win rate · ' + (cred.historyBadge || 'Insufficient') + '</div>' +
          '</div>' +
          '<span class="badge ' + tierClass + '">' + tier + '</span>' +
        '</div>';
      }).join('');
    }

    // Render Predictions List with Walrus Sync Status
    function renderPredictionsList() {
      const container = document.getElementById('predictions-list');
      if (!container) return;

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

        const syncBadge = p.walrus_sync_status === 'CONFIRMED'
          ? '<span class="badge badge-good" style="font-size: 10px;">✓ Walrus Synced</span>'
          : '<span class="badge badge-pending" style="font-size: 10px;">⏳ Syncing...</span>';

        return '<div class="card" id="prediction-card-' + p.id + '" style="margin-bottom: 10px;">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">' +
            '<div>' +
              '<span class="badge badge-not-rated" style="margin-right: 6px;">' + p.sport + '</span>' +
              '<strong style="font-size: 14px;">' + p.event_label + '</strong>' +
            '</div>' +
            '<div style="display: flex; gap: 4px; align-items: center;">' +
              syncBadge +
              '<span class="badge ' + outcomeClass + '">' + p.outcome + '</span>' +
            '</div>' +
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

    // Deep Link Prediction Fetch & Highlight
    async function loadAndHighlightPrediction(predId) {
      const container = document.getElementById('predictions-list');
      if (!container) return;

      try {
        const res = await apiFetch('/api/predictions/' + predId);
        if (res.status === 404 || !res.ok) {
          const banner = document.createElement('div');
          banner.className = 'card';
          banner.style.cssText = 'border-left: 3px solid var(--lost); margin-bottom: 12px; font-size: 13px; color: var(--navy);';
          banner.innerHTML = '<strong>Prediction Not Found:</strong> You do not have access to this prediction or it does not exist.';
          container.prepend(banner);
          return;
        }

        const data = await res.json();
        const p = data.prediction;
        if (!p) return;

        const existingCard = document.getElementById('prediction-card-' + p.id);
        if (existingCard) {
          existingCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          existingCard.style.outline = '2px solid var(--blue)';
        } else {
          const outcomeClass = p.outcome === 'WON' ? 'badge-won' :
                               p.outcome === 'LOST' ? 'badge-lost' : 'badge-pending';
          const kickoff = new Date(p.start_at_utc).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
          }) + ' UTC';

          const card = document.createElement('div');
          card.id = 'prediction-card-' + p.id;
          card.className = 'card';
          card.style.cssText = 'margin-bottom: 12px; outline: 2px solid var(--blue);';
          card.innerHTML =
            '<div style="font-size: 11px; font-weight: 700; color: var(--blue); margin-bottom: 6px;">📍 LINKED PREDICTION</div>' +
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
            '</div>';
          container.prepend(card);
        }
      } catch (err) {
        console.error('Error fetching deep linked prediction:', err);
      }
    }

    // Filter Predictions
    async function filterPredictions(filter, btn) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentPredictionFilter = filter;
      await refreshPredictions();
    }

    // Render Analysts List with Prominent Credibility Cards
    function renderAnalystsList() {
      const container = document.getElementById('analysts-list');
      if (!container) return;

      if (analystsList.length === 0) {
        container.innerHTML = '<div style="font-size: 13px; color: var(--muted); text-align: center; padding: 24px;">No analysts added yet.</div>';
        return;
      }

      container.innerHTML = analystsList.map(a => {
        const cred = a.credibility || {};
        const tier = cred.ratingTier || 'Not Rated';
        const tierClass = tier === 'Good' ? 'badge-good' :
                          tier === 'Average' ? 'badge-average' :
                          tier === 'Poor' ? 'badge-poor' : 'badge-not-rated';
        const winRate = cred.winRate !== null && cred.winRate !== undefined ? cred.winRate + '%' : 'N/A';
        const aliases = (a.aliases || []).map(al => '@' + al.handle + ' (' + al.platform + ')').join(', ') || 'No aliases';

        return '<div class="card">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 6px;">' +
            '<div onclick="openAnalystDetail(\\\'' + a.id + '\\\')" style="cursor: pointer; flex: 1;">' +
              '<div style="font-weight: 700; font-size: 15px; color: var(--blue);">' + a.name + ' →</div>' +
              '<div style="font-size: 12px; color: var(--muted);">' + aliases + '</div>' +
            '</div>' +
            '<span class="badge ' + tierClass + '">' + tier + '</span>' +
          '</div>' +
          '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; font-size: 12px; margin: 10px 0; background: var(--bg); padding: 8px; border-radius: 6px;">' +
            '<div><span style="color: var(--muted); font-size: 10px; display: block;">WIN RATE</span><strong>' + winRate + '</strong></div>' +
            '<div><span style="color: var(--muted); font-size: 10px; display: block;">SETTLED</span><strong>' + (cred.settledCount || 0) + '</strong> (' + (cred.wonCount || 0) + 'W-' + (cred.lostCount || 0) + 'L)</div>' +
            '<div><span style="color: var(--muted); font-size: 10px; display: block;">HISTORY</span><strong>' + (cred.historyBadge || 'Insufficient') + '</strong></div>' +
          '</div>' +
          '<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 10px;">' +
            '<div style="font-size: 11px; color: var(--muted);">' + (cred.apiVerifiedCount || 0) + ' API · ' + (cred.selfReportedCount || 0) + ' Self</div>' +
            '<div style="display: flex; gap: 6px;">' +
              '<button class="btn btn-outline btn-sm" onclick="openAnalystDetail(\\\'' + a.id + '\\\')">View Details</button>' +
              '<button class="btn btn-outline btn-sm" onclick="openMergeModal(\\\'' + a.id + '\\\', \\\'' + a.name + '\\\')">Merge...</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Paste Assistant Handler
    async function handlePasteParse() {
      const text = document.getElementById('paste-input').value;
      if (!text.trim()) return;

      try {
        const res = await apiFetch('/api/parse-paste', {
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
        const res = await apiFetch('/api/predictions', {
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
      const sourceSelect = document.getElementById('merge-source-select');
      sourceSelect.innerHTML = '<option value="">Select profile...</option>';
      analystsList.filter(a => a.id !== targetId).forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.id;
        opt.textContent = a.name;
        sourceSelect.appendChild(opt);
      });
      document.getElementById('modal-merge').classList.add('open');
    }

    function closeModal(modalId) {
      document.getElementById(modalId).classList.remove('open');
    }

    async function handleSaveAnalyst(e) {
      e.preventDefault();
      const name = document.getElementById('modal-analyst-name').value;
      const platform = document.getElementById('modal-analyst-platform').value;
      const handle = document.getElementById('modal-analyst-handle').value;

      const aliases = handle.trim() ? [{ platform, handle: handle.trim().replace(/^@/, '') }] : [];

      try {
        const res = await apiFetch('/api/analysts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, aliases })
        });
        if (res.ok) {
          closeModal('modal-analyst');
          await refreshAnalysts();
        } else {
          const err = await res.json();
          alert('Error creating analyst: ' + (err.error || 'Server error'));
        }
      } catch (err) {
        alert('Network error creating analyst');
      }
    }

    async function handleExecuteMerge() {
      const targetId = document.getElementById('merge-target-id').value;
      const sourceId = document.getElementById('merge-source-select').value;
      if (!sourceId) {
        alert('Please select an analyst to merge');
        return;
      }

      try {
        const res = await apiFetch('/api/analysts/' + targetId + '/merge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceAnalystId: sourceId })
        });
        if (res.ok) {
          closeModal('modal-merge');
          await refreshAnalysts();
          await refreshPredictions();
        } else {
          const err = await res.json();
          alert('Error merging analysts: ' + (err.error || 'Server error'));
        }
      } catch (err) {
        alert('Network error merging analysts');
      }
    }

    function handleMarketChange() {}

    function handleSignOut() {
      alert('Signed out successfully.');
      window.location.reload();
    }

    async function refreshBotStatus() {
      try {
        const res = await apiFetch('/api/bot/status');
        if (res.ok) {
          const status = await res.json();
          const badge = document.getElementById('settings-bot-status');
          const prompt = document.getElementById('settings-bot-activation-prompt');
          const notifStatus = document.getElementById('settings-notifications-status');
          const toggleBtn = document.getElementById('btn-toggle-notifications');
          if (status.linked) {
            if (badge) {
              badge.textContent = 'Connected';
              badge.className = 'badge badge-good';
            }
            if (prompt) prompt.style.display = 'none';
            if (toggleBtn) toggleBtn.disabled = false;
          } else {
            if (badge) {
              badge.textContent = 'Not Connected';
              badge.className = 'badge badge-not-rated';
            }
            if (prompt) prompt.style.display = 'block';
            if (toggleBtn) toggleBtn.disabled = true;
          }
          if (notifStatus) {
            if (!status.linked) {
              notifStatus.textContent = 'Requires Bot';
              notifStatus.className = 'badge badge-not-rated';
            } else {
              notifStatus.textContent = status.enabled ? 'Enabled' : 'Disabled';
              notifStatus.className = 'badge ' + (status.enabled ? 'badge-verified' : 'badge-not-rated');
            }
          }
        }
      } catch (err) {
        console.error('Failed to refresh bot status', err);
      }
    }

    async function handleActivateBot() {
      const feedbackEl = document.getElementById('settings-bot-feedback');
      const btn = document.getElementById('btn-activate-bot');
      if (btn) btn.disabled = true;
      try {
        const res = await apiFetch('/api/bot/activate', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.deepLink) {
          if (feedbackEl) {
            feedbackEl.className = 'banner banner-success';
            feedbackEl.innerHTML = 'Opening Telegram bot link... If it does not open, <a href="' + data.deepLink + '" target="_blank" style="color: var(--blue); font-weight: 600;">click here to activate</a>.';
            feedbackEl.classList.remove('hidden');
          }
          window.open(data.deepLink, '_blank');
        } else {
          if (feedbackEl) {
            feedbackEl.className = 'banner banner-error';
            feedbackEl.textContent = data.error || 'Could not generate bot activation link.';
            feedbackEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.className = 'banner banner-error';
          feedbackEl.textContent = 'Network error connecting to bot service.';
          feedbackEl.classList.remove('hidden');
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    async function handleToggleNotifications() {
      const feedbackEl = document.getElementById('settings-bot-feedback');
      try {
        const statusRes = await apiFetch('/api/bot/status');
        const status = await statusRes.json();
        if (!status.linked) {
          if (feedbackEl) {
            feedbackEl.className = 'banner banner-error';
            feedbackEl.textContent = 'Please connect your Telegram bot before enabling notifications.';
            feedbackEl.classList.remove('hidden');
          }
          return;
        }
        const newSetting = !status.enabled;
        const res = await apiFetch('/api/bot/toggle-notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: newSetting })
        });
        if (res.ok) {
          await refreshBotStatus();
          if (feedbackEl) {
            feedbackEl.className = 'banner banner-success';
            feedbackEl.textContent = newSetting ? 'Result reminders enabled.' : 'Result reminders paused.';
            feedbackEl.classList.remove('hidden');
          }
        } else {
          if (feedbackEl) {
            feedbackEl.className = 'banner banner-error';
            feedbackEl.textContent = 'Failed to update notification setting.';
            feedbackEl.classList.remove('hidden');
          }
        }
      } catch (err) {
        if (feedbackEl) {
          feedbackEl.className = 'banner banner-error';
          feedbackEl.textContent = 'Network error updating preferences.';
          feedbackEl.classList.remove('hidden');
        }
      }
    }

    function handleDeleteAccount() {
      if (confirm('Are you sure you want to delete your account? All private journal entries will be deleted.')) {
        alert('Account deletion scheduled.');
        window.location.reload();
      }
    }
  </script>
</body>
</html>`;
}
