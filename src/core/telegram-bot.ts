/**
 * Telegram Bot — Linking, Webhook Processing & Notification Dispatch
 *
 * Implements:
 * 1. Single-use linking token generation (SHA-256 stored, plaintext in deep link).
 * 2. Webhook authenticity verification via X-Telegram-Bot-Api-Secret-Token header.
 * 3. Bot link confirmation after /start deep-link callback.
 * 4. Cross-user authorization: chat_id must match the authenticated user's telegram_id.
 * 5. Inline button callback authentication via HMAC-signed nonce.
 * 6. Notification dispatch with idempotency key deduplication.
 * 7. Rate-limit and blocked-user handling.
 *
 * Security invariants:
 * - Telegram user IDs from webhook are NEVER trusted without server verification.
 * - Bot links are confirmed only when the linking chat_id matches the WhoWasRight
 *   user's verified telegram_id (from their authenticated login session).
 * - All callback_query handlers re-verify authorization before any state mutation.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { query, withTransaction } from './db.ts';
import { settlePrediction, type PredictionOutcome } from './predictions.ts';

// ============================================================
// Types
// ============================================================
export interface BotLinkStatus {
  linked: boolean;
  enabled: boolean;
  telegramChatId?: number;
  linkedAt?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string };
    chat: { id: number; type: string };
    text?: string;
    connected_website?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

export interface SendNotificationParams {
  userId: string;
  predictionId: string;
  notificationType: 'SETTLEMENT_AUTO' | 'SETTLEMENT_MANUAL' | 'CORRECTION';
  payload: {
    eventName: string;
    analystName: string;
    market: string;
    selection: string;
    outcome?: string;
    score?: string;
    reason?: string;
    viewUrl: string;
  };
}

// ============================================================
// Bot Username & Canonical Domain Resolvers
// ============================================================

/**
 * Resolves the configured Telegram bot username from either TELEGRAM_BOT_USERNAME or TELEGRAM_BOT_NAME.
 * Normalizes leading '@' and whitespace.
 * Validates 3-32 characters, alphanumeric and underscore.
 * Returns null if not configured or invalid.
 */
export function getBotUsername(): string | null {
  const raw = process.env.TELEGRAM_BOT_USERNAME || process.env.TELEGRAM_BOT_NAME;
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^@+/, '').trim();
  if (!cleaned || !/^[a-zA-Z0-9_]{3,32}$/i.test(cleaned)) {
    return null;
  }
  return cleaned;
}

/**
 * Resolves the canonical domain for the application.
 * Normalized to lowercase hostname without protocol, port, or path.
 * Checks APP_BASE_URL, RENDER_EXTERNAL_URL, CANONICAL_DOMAIN, falling back to 'whowasright.onrender.com'.
 */
export function getCanonicalDomain(): string {
  const envUrl = process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || process.env.CANONICAL_DOMAIN;
  if (envUrl) {
    try {
      const url = envUrl.includes('://') ? new URL(envUrl) : new URL(`https://${envUrl}`);
      return url.hostname.toLowerCase();
    } catch {
      return envUrl.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
    }
  }
  return 'whowasright.onrender.com';
}

/**
 * Confirms whether the incoming connected_website domain matches the canonical domain.
 */
export function isCanonicalDomain(domain: string | undefined): boolean {
  if (!domain || typeof domain !== 'string') return false;
  const canonical = getCanonicalDomain();
  const incoming = domain.trim().toLowerCase();
  return incoming === canonical;
}

// ============================================================
// Linking Token Generation & Verification
// ============================================================

/**
 * Generates a single-use bot linking token for the authenticated user.
 * Returns the plaintext token (for the deep link) and stores only its SHA-256 hash.
 */
export async function generateBotLinkToken(userId: string): Promise<{
  plaintextToken: string;
  deepLink: string;
}> {
  const botUsername = getBotUsername();
  if (!botUsername) {
    const configuredVar = process.env.TELEGRAM_BOT_USERNAME !== undefined
      ? 'TELEGRAM_BOT_USERNAME'
      : process.env.TELEGRAM_BOT_NAME !== undefined
        ? 'TELEGRAM_BOT_NAME'
        : null;
    if (configuredVar) {
      throw new Error(`Telegram bot username configured in ${configuredVar} is invalid`);
    }
    throw new Error('Telegram bot username is not configured (set TELEGRAM_BOT_USERNAME or TELEGRAM_BOT_NAME)');
  }

  // Expire any existing unused tokens for this user first
  await query(
    `UPDATE bot_link_tokens SET expires_at = NOW() WHERE user_id = $1 AND used_at IS NULL;`,
    [userId]
  );

  const plaintextToken = randomBytes(16).toString('hex');
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');

  await query(
    `INSERT INTO bot_link_tokens (token_hash, user_id)
     VALUES ($1, $2);`,
    [tokenHash, userId]
  );

  return {
    plaintextToken,
    deepLink: `https://t.me/${botUsername}?start=link_${plaintextToken}`,
  };
}

/**
 * Handles Telegram's connected_website service message from Telegram Login Widget (data-request-access="write").
 * Invariants:
 * 1. Confirms connected_website domain matches canonical production domain.
 * 2. Requires a private chat and identifies account via message.chat.id.
 * 3. Matches chat.id against an existing, non-deleted users.telegram_id.
 * 4. Never creates accounts from webhook events.
 * 5. Idempotent: repeated updates do not duplicate records or overwrite disabled notification preferences.
 * 6. Prevents cross-account reassignment: chat.id cannot be bound to another user.
 */
export async function handleConnectedWebsite(message: {
  chat?: { id: number; type: string };
  from?: { id: number; username?: string };
  connected_website?: string;
}): Promise<{
  success: boolean;
  ignored?: boolean;
  reason?: string;
  alreadyLinked?: boolean;
}> {
  if (!isCanonicalDomain(message.connected_website)) {
    return { success: false, ignored: true, reason: 'Domain mismatch' };
  }

  if (!message.chat || message.chat.type !== 'private') {
    return { success: false, ignored: true, reason: 'Chat must be private' };
  }

  const telegramChatId = message.chat.id;
  if (!telegramChatId || typeof telegramChatId !== 'number') {
    return { success: false, ignored: true, reason: 'Invalid chat ID' };
  }

  const userRes = await query<{
    id: string;
    telegram_id: string;
  }>(
    `SELECT id, telegram_id
     FROM users
     WHERE telegram_id = $1 AND deleted_at IS NULL;`,
    [telegramChatId]
  );

  if (userRes.rows.length === 0) {
    return { success: false, ignored: true, reason: 'User not found or deleted' };
  }

  const userId = userRes.rows[0].id;

  return withTransaction(async (client) => {
    // Check if telegramChatId is already linked to a DIFFERENT user
    const conflictRes = await client.query<{ user_id: string }>(
      `SELECT user_id FROM bot_links WHERE telegram_chat_id = $1;`,
      [telegramChatId]
    );

    if (conflictRes.rows.length > 0 && conflictRes.rows[0].user_id !== userId) {
      return {
        success: false,
        reason: 'Telegram chat already linked to a different account',
      };
    }

    // Check if this user already has a bot_links record
    const existingLinkRes = await client.query<{
      telegram_chat_id: string;
      enabled: boolean;
    }>(
      `SELECT telegram_chat_id, enabled FROM bot_links WHERE user_id = $1 FOR UPDATE;`,
      [userId]
    );

    if (existingLinkRes.rows.length > 0) {
      const existingLink = existingLinkRes.rows[0];
      const existingChatId = Number(existingLink.telegram_chat_id);

      if (existingChatId !== telegramChatId) {
        return {
          success: false,
          reason: 'Account already linked to a different Telegram chat',
        };
      }

      // Repeated update for already linked account: preserve existing notification preference
      await client.query(
        `UPDATE bot_links SET updated_at = NOW() WHERE user_id = $1;`,
        [userId]
      );

      return { success: true, alreadyLinked: true };
    }

    // New link: initialize with enabled = false (Settings toggle is explicit opt-in)
    await client.query(
      `INSERT INTO bot_links (user_id, telegram_chat_id, enabled, linked_at, updated_at)
       VALUES ($1, $2, FALSE, NOW(), NOW());`,
      [userId, telegramChatId]
    );

    return { success: true, alreadyLinked: false };
  });
}

/**
 * Confirms a bot link after the user opens the deep link in Telegram.
 * Validates: token unused, not expired, chat_id matches user's verified telegram_id.
 */
export async function confirmBotLink(params: {
  plaintextToken: string;
  telegramChatId: number;
}): Promise<{ success: boolean; reason?: string }> {
  const { plaintextToken, telegramChatId } = params;
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');

  return withTransaction(async (client) => {
    // 1. Fetch and lock the token row
    const tokenRes = await client.query<{
      id: string;
      user_id: string;
      expires_at: string;
      used_at: string | null;
    }>(
      `SELECT id, user_id, expires_at, used_at
       FROM bot_link_tokens
       WHERE token_hash = $1
       FOR UPDATE;`,
      [tokenHash]
    );

    if (tokenRes.rows.length === 0) {
      return { success: false, reason: 'Invalid or unrecognised linking token' };
    }

    const tokenRow = tokenRes.rows[0];

    if (tokenRow.used_at) {
      return { success: false, reason: 'Linking token already used' };
    }

    if (new Date(tokenRow.expires_at) < new Date()) {
      return { success: false, reason: 'Linking token has expired' };
    }

    // 2. Verify the Telegram chat_id matches this user's verified telegram_id
    const userRes = await client.query<{ telegram_id: string }>(
      `SELECT telegram_id FROM users WHERE id = $1 AND deleted_at IS NULL;`,
      [tokenRow.user_id]
    );

    if (userRes.rows.length === 0) {
      return { success: false, reason: 'User account not found' };
    }

    const userTelegramId = Number(userRes.rows[0].telegram_id);
    if (userTelegramId !== telegramChatId) {
      // The Telegram account that opened the deep link differs from the WhoWasRight account owner.
      // This prevents cross-account linking attacks.
      return {
        success: false,
        reason: 'Telegram account does not match your WhoWasRight account. Please sign in with the correct Telegram account.',
      };
    }

    // 3. Mark token as used (atomic)
    await client.query(
      `UPDATE bot_link_tokens SET used_at = NOW() WHERE id = $1;`,
      [tokenRow.id]
    );

    // 4. Upsert bot_links
    await client.query(
      `INSERT INTO bot_links (user_id, telegram_chat_id, enabled, linked_at, updated_at)
       VALUES ($1, $2, TRUE, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET telegram_chat_id = EXCLUDED.telegram_chat_id,
             enabled = TRUE,
             updated_at = NOW();`,
      [tokenRow.user_id, telegramChatId]
    );

    return { success: true };
  });
}

// ============================================================
// Bot Link Status & Preferences
// ============================================================

export async function getBotLinkStatus(userId: string): Promise<BotLinkStatus> {
  const res = await query<{
    telegram_chat_id: string;
    enabled: boolean;
    linked_at: string;
  }>(
    `SELECT telegram_chat_id, enabled, linked_at FROM bot_links WHERE user_id = $1;`,
    [userId]
  );

  if (res.rows.length === 0) {
    return { linked: false, enabled: false };
  }

  return {
    linked: true,
    enabled: res.rows[0].enabled,
    telegramChatId: Number(res.rows[0].telegram_chat_id),
    linkedAt: res.rows[0].linked_at,
  };
}

export async function toggleNotifications(userId: string, enabled: boolean): Promise<boolean> {
  const res = await query(
    `UPDATE bot_links SET enabled = $1, updated_at = NOW()
     WHERE user_id = $2;`,
    [enabled, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ============================================================
// Webhook Signature Verification
// ============================================================

/**
 * Verifies the X-Telegram-Bot-Api-Secret-Token header matches our configured secret.
 * Must be called on every incoming webhook request before processing.
 */
export function verifyWebhookSecret(headerValue: string | undefined): boolean {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !headerValue) return false;
  // Constant-time comparison to prevent timing attacks
  const expected = Buffer.from(secret);
  const received = Buffer.from(headerValue);
  if (expected.length !== received.length) return false;
  // Use Node's timingSafeEqual via crypto module workaround
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected[i] ^ received[i];
  }
  return diff === 0;
}

// ============================================================
// Callback Nonce Generation & Verification
// ============================================================

const CALLBACK_NONCE_TTL_MS = 15 * 60 * 1000; // 15 minutes

const OUTCOME_CODE_MAP: Record<string, string> = {
  WON: 'W',
  LOST: 'L',
  PUSH: 'P',
};

const CODE_OUTCOME_MAP: Record<string, string> = {
  W: 'WON',
  L: 'LOST',
  P: 'PUSH',
};

/**
 * Generates an HMAC-signed compact nonce for Telegram inline button callback data.
 * Telegram enforces a strict 64-byte limit on callback_data.
 *
 * Compact format: `s:{cleanHex32}:{outcomeCode}:{tsSec}:{hmac16}`
 * Total length is exactly 64 bytes, strictly within Telegram's 64-byte limit.
 *
 * Security:
 * - chatId is bound into the HMAC message so the nonce cannot be reused by another user or chat.
 * - timestamp (in seconds) enforces the 15-minute expiry.
 * - predictionId (32 hex chars) is verified against ownership upon receipt.
 * - HMAC signature is 16 hexadecimal characters (64 bits of entropy).
 */
export function generateCallbackNonce(params: {
  predictionId: string;
  outcome: string;
  chatId: number;
}): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET not configured');
  const { predictionId, outcome, chatId } = params;

  const cleanHex = predictionId.replace(/-/g, '').toLowerCase();
  const outcomeCode = OUTCOME_CODE_MAP[outcome] || outcome;
  const tsSec = Math.floor(Date.now() / 1000);

  // HMAC binds predictionId, outcomeCode, chatId, and timestamp
  const message = `${cleanHex}:${outcomeCode}:${chatId}:${tsSec}`;
  const hmac = createHmac('sha256', secret).update(message).digest('hex').substring(0, 16);

  return `s:${cleanHex}:${outcomeCode}:${tsSec}:${hmac}`;
}

/**
 * Verifies a callback nonce from an inline button press.
 * Supports compact format `s:...` (<= 64 bytes) and legacy `settle:...`.
 * Returns parsed fields if valid, null if invalid or expired.
 */
export function verifyCallbackNonce(
  callbackData: string,
  fromChatId: number
): { predictionId: string; outcome: string } | null {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !callbackData || typeof callbackData !== 'string') return null;

  // 1. Compact format: s:{cleanHex32}:{outcomeCode}:{tsSec}:{hmac16}
  if (callbackData.startsWith('s:')) {
    const parts = callbackData.split(':');
    if (parts.length !== 5) return null;

    const [, cleanHex, outcomeCode, tsSecStr, receivedHmac] = parts;
    if (!/^[0-9a-f]{32}$/i.test(cleanHex)) return null;

    const outcome = CODE_OUTCOME_MAP[outcomeCode];
    if (!outcome) return null;

    const tsSec = Number(tsSecStr);
    if (!Number.isInteger(tsSec)) return null;

    const tsMs = tsSec * 1000;
    const now = Date.now();
    // Expiry check (15 min) + reasonable clock-skew tolerance (60s in future)
    if (now - tsMs > CALLBACK_NONCE_TTL_MS || tsMs > now + 60000) {
      return null;
    }

    // Re-compute HMAC with caller's chat ID (16 hex chars)
    const message = `${cleanHex.toLowerCase()}:${outcomeCode}:${fromChatId}:${tsSec}`;
    const expectedHmac = createHmac('sha256', secret).update(message).digest('hex').substring(0, 16);

    if (receivedHmac.length !== expectedHmac.length) return null;
    let diff = 0;
    for (let i = 0; i < expectedHmac.length; i++) {
      diff |= expectedHmac.charCodeAt(i) ^ receivedHmac.charCodeAt(i);
    }
    if (diff !== 0) return null;

    // Restore canonical UUID format
    const predictionId = `${cleanHex.slice(0, 8)}-${cleanHex.slice(8, 12)}-${cleanHex.slice(12, 16)}-${cleanHex.slice(16, 20)}-${cleanHex.slice(20)}`.toLowerCase();
    return { predictionId, outcome };
  }

  // 2. Legacy fallback: settle:{predictionId}:{outcome}:{chatId}:{timestamp}:{hmac}
  if (callbackData.startsWith('settle:')) {
    const parts = callbackData.split(':');
    if (parts.length !== 6) return null;

    const [, predictionId, outcome, chatIdStr, timestampStr, receivedHmac] = parts;
    const chatId = Number(chatIdStr);
    const timestamp = Number(timestampStr);

    if (Number.isNaN(chatId) || Number.isNaN(timestamp)) return null;
    if (chatId !== fromChatId) return null;
    if (Date.now() - timestamp > CALLBACK_NONCE_TTL_MS) return null;

    const message = `${predictionId}:${outcome}:${chatId}:${timestamp}`;
    const expectedHmac = createHmac('sha256', secret).update(message).digest('hex').substring(0, 16);

    if (receivedHmac.length !== expectedHmac.length) return null;
    let diff = 0;
    for (let i = 0; i < expectedHmac.length; i++) {
      diff |= expectedHmac.charCodeAt(i) ^ receivedHmac.charCodeAt(i);
    }
    if (diff !== 0) return null;

    return { predictionId, outcome };
  }

  return null;
}

// ============================================================
// Notification Queue
// ============================================================

/**
 * Enqueues a notification. Idempotent: duplicate idempotency keys are silently ignored.
 * Never sends immediately — the notification worker dispatches queued items.
 */
export async function enqueueNotification(params: SendNotificationParams): Promise<string | null> {
  const { userId, predictionId, notificationType, payload } = params;

  // Check user has bot enabled
  const linkRes = await query<{ enabled: boolean }>(
    `SELECT enabled FROM bot_links WHERE user_id = $1;`,
    [userId]
  );
  if (linkRes.rows.length === 0 || !linkRes.rows[0].enabled) {
    return null; // Bot not linked or disabled — silently skip
  }

  const idempotencyKey = `notif-${predictionId}-${notificationType}-${params.payload.outcome ?? 'prompt'}`;

  const res = await query<{ id: string }>(
    `INSERT INTO notification_queue
       (user_id, prediction_id, notification_type, payload_json, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id;`,
    [userId, predictionId, notificationType, JSON.stringify(payload), idempotencyKey]
  );

  return res.rows[0]?.id ?? null;
}

// ============================================================
// Telegram API Client
// ============================================================

/** Bounded HTTP request timeout (15s), safely below the 5-minute stale notification threshold */
export const TELEGRAM_REQUEST_TIMEOUT_MS = 15_000;

async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS),
  });

  const data = await res.json() as any;
  if (!data.ok) {
    throw Object.assign(new Error(`Telegram API error: ${data.description}`), {
      code: data.error_code,
      retryAfter: data.parameters?.retry_after,
    });
  }
  return data.result;
}

/**
 * Recovers notifications left in SENDING after an interrupted worker.
 * Stale if updated_at < NOW() - INTERVAL '5 minutes'.
 * If attempts >= 5, marks FAILED. Otherwise resets to PENDING with attempts incremented.
 */
export async function recoverStaleSendingNotifications(staleMinutes = 5): Promise<number> {
  // 1. Mark rows with attempts >= 5 as FAILED
  await query(
    `UPDATE notification_queue
     SET status = 'FAILED',
         error = 'Interrupted worker: maximum attempts reached in SENDING state',
         updated_at = NOW()
     WHERE status = 'SENDING'
       AND updated_at < NOW() - ($1 || ' minutes')::interval
       AND attempts >= 5;`,
    [staleMinutes]
  );

  // 2. Recover other stale SENDING rows back to PENDING with attempts incremented
  const res = await query(
    `UPDATE notification_queue
     SET status = 'PENDING',
         attempts = attempts + 1,
         next_retry_at = NOW(),
         error = 'Recovered from stale SENDING state after worker interruption',
         updated_at = NOW()
     WHERE status = 'SENDING'
       AND updated_at < NOW() - ($1 || ' minutes')::interval;`,
    [staleMinutes]
  );

  return res.rowCount ?? 0;
}

/**
 * Processes pending notifications from the queue.
 * Call from the cron endpoint after settlement.
 * Respects Telegram rate limits; marks blocked/deleted chats as BLOCKED.
 * Concurrency-safe: claims rows atomically via UPDATE ... FOR UPDATE SKIP LOCKED.
 */
export async function processNotificationQueue(maxItems = 20): Promise<{
  sent: number;
  failed: number;
  blocked: number;
}> {
  const stats = { sent: 0, failed: 0, blocked: 0 };

  // 1. Recover stale SENDING notifications from interrupted workers
  await recoverStaleSendingNotifications();

  // 2. Atomically claim pending notifications and transition to SENDING
  const pendingRes = await query<{
    id: string;
    user_id: string;
    prediction_id: string;
    notification_type: string;
    payload_json: any;
    attempts: number;
  }>(
    `UPDATE notification_queue
     SET status = 'SENDING', updated_at = NOW()
     WHERE id IN (
       SELECT id
       FROM notification_queue
       WHERE status = 'PENDING'
         AND next_retry_at <= NOW()
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, user_id, prediction_id, notification_type, payload_json, attempts;`,
    [maxItems]
  );

  for (const item of pendingRes.rows) {
    // Get chat_id for this user
    const linkRes = await query<{ telegram_chat_id: string }>(
      `SELECT telegram_chat_id FROM bot_links WHERE user_id = $1 AND enabled = TRUE;`,
      [item.user_id]
    );

    if (linkRes.rows.length === 0) {
      await query(
        `UPDATE notification_queue SET status = 'BLOCKED', error = 'Bot not linked or disabled', updated_at = NOW() WHERE id = $1;`,
        [item.id]
      );
      stats.blocked++;
      continue;
    }

    const chatId = Number(linkRes.rows[0].telegram_chat_id);
    const payload = item.payload_json as SendNotificationParams['payload'];

    try {
      if (item.notification_type === 'SETTLEMENT_AUTO') {
        await sendAutoSettlementMessage(chatId, payload);
      } else if (item.notification_type === 'SETTLEMENT_MANUAL') {
        await sendManualSettlementPrompt(chatId, item.prediction_id, payload);
      } else if (item.notification_type === 'CORRECTION') {
        await sendCorrectionMessage(chatId, payload);
      }

      await query(
        `UPDATE notification_queue SET status = 'SENT', sent_at = NOW(), attempts = attempts + 1, error = NULL, updated_at = NOW() WHERE id = $1;`,
        [item.id]
      );
      stats.sent++;
    } catch (err: unknown) {
      const e = err as any;
      const attempts = item.attempts + 1;
      const isBlocked = e.code === 403; // Bot blocked by user
      const isInvalidChat = e.code === 400 && String(e.message).includes('chat not found');
      const retryAfterMs = e.retryAfter ? e.retryAfter * 1000 : Math.pow(2, attempts) * 1000;

      if (isBlocked || isInvalidChat) {
        await query(
          `UPDATE notification_queue SET status = 'BLOCKED', attempts = $1, error = $2, updated_at = NOW() WHERE id = $3;`,
          [attempts, String(e.message), item.id]
        );
        // Disable bot link to stop future sends
        await query(`UPDATE bot_links SET enabled = FALSE, updated_at = NOW() WHERE user_id = $1;`, [item.user_id]);
        stats.blocked++;
      } else if (attempts >= 5) {
        await query(
          `UPDATE notification_queue SET status = 'FAILED', attempts = $1, error = $2, updated_at = NOW() WHERE id = $3;`,
          [attempts, String(e.message), item.id]
        );
        stats.failed++;
      } else {
        const nextRetry = new Date(Date.now() + retryAfterMs);
        await query(
          `UPDATE notification_queue SET status = 'PENDING', attempts = $1, error = $2, next_retry_at = $3, updated_at = NOW() WHERE id = $4;`,
          [attempts, String(e.message), nextRetry, item.id]
        );
      }
    }
  }

  return stats;
}

// ============================================================
// Message Formatters
// ============================================================

async function sendAutoSettlementMessage(chatId: number, payload: SendNotificationParams['payload']): Promise<void> {
  const outcome = payload.outcome ?? 'UNKNOWN';
  const isVoid = outcome === 'VOID';
  const emoji = outcome === 'WON' ? '✅' : outcome === 'LOST' ? '❌' : '↩️';
  const appUrl = process.env.APP_BASE_URL ?? '';
  const title = isVoid ? 'Match Cancelled — Pick Voided' : 'Result Verified';
  const scoreLine = (!isVoid && payload.score) ? `*Score:* ${escapeMarkdown(payload.score)}\n` : '';

  const text =
    `${emoji} *${escapeMarkdown(title)}*\n\n` +
    `*Match:* ${escapeMarkdown(payload.eventName)}\n` +
    `*Analyst:* ${escapeMarkdown(payload.analystName)}\n` +
    `*Pick:* ${escapeMarkdown(payload.market)} — ${escapeMarkdown(payload.selection)}\n` +
    `*Result:* *${outcome}*\n` +
    scoreLine +
    `*Evidence:* ${escapeMarkdown(payload.reason ?? (isVoid ? 'Match cancelled; pick voided' : '—'))}\n\n` +
    `_API\\-Verified result_`;

  await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 View Prediction', url: `${appUrl}${payload.viewUrl}` },
      ]],
    },
  });
}

async function sendManualSettlementPrompt(
  chatId: number,
  predictionId: string,
  payload: SendNotificationParams['payload']
): Promise<void> {
  const appUrl = process.env.APP_BASE_URL ?? '';

  const wonNonce = generateCallbackNonce({ predictionId, outcome: 'WON', chatId });
  const lostNonce = generateCallbackNonce({ predictionId, outcome: 'LOST', chatId });
  const pushNonce = generateCallbackNonce({ predictionId, outcome: 'PUSH', chatId });

  const text =
    `⏳ *Manual Settlement Required*\n\n` +
    `*Match:* ${escapeMarkdown(payload.eventName)}\n` +
    `*Analyst:* ${escapeMarkdown(payload.analystName)}\n` +
    `*Pick:* ${escapeMarkdown(payload.market)} — ${escapeMarkdown(payload.selection)}\n\n` +
    `Automatic verification is not available for this market\\. Please record the result:`;

  await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Won', callback_data: wonNonce },
          { text: '❌ Lost', callback_data: lostNonce },
          { text: '↩️ Push', callback_data: pushNonce },
        ],
        [
          { text: '📊 View Prediction', url: `${appUrl}${payload.viewUrl}` },
        ],
      ],
    },
  });
}

async function sendCorrectionMessage(chatId: number, payload: SendNotificationParams['payload']): Promise<void> {
  const appUrl = process.env.APP_BASE_URL ?? '';
  const text =
    `📝 *Correction Recorded*\n\n` +
    `*Match:* ${escapeMarkdown(payload.eventName)}\n` +
    `*Analyst:* ${escapeMarkdown(payload.analystName)}\n` +
    `*Updated result:* ${escapeMarkdown(payload.outcome ?? '—')}\n\n` +
    `_Self\\-reported correction \\— credibility updated_`;

  await callTelegramApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '📊 View Prediction', url: `${appUrl}${payload.viewUrl}` },
      ]],
    },
  });
}

/** Escapes special characters for Telegram MarkdownV2 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ============================================================
// Answer Callback Query (acknowledge button press)
// ============================================================
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text ?? '',
    });
  } catch {
    // Non-fatal: answering Telegram button spinner is best-effort and must not fail settlement
  }
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  await callTelegramApi('sendMessage', { chat_id: chatId, text });
}

/**
 * Processes an incoming inline button callback query from Telegram.
 * Enforces:
 * 1. HMAC signature and expiry verification via verifyCallbackNonce.
 * 2. Cross-user isolation: verification that chat_id belongs to the prediction's owner.
 * 3. Atomic transition: exactly one execution succeeds in PostgreSQL; concurrent or
 *    subsequent requests receive an already-settled response without duplicate side effects.
 */
export async function handleTelegramCallbackQuery(params: {
  callbackData: string;
  fromChatId: number;
  callbackQueryId: string;
}): Promise<{
  success: boolean;
  outcome?: string;
  alreadySettled?: boolean;
  unauthorized?: boolean;
  error?: string;
}> {
  const { callbackData, fromChatId, callbackQueryId } = params;

  if (!callbackData.startsWith('s:') && !callbackData.startsWith('settle:')) {
    return { success: false, error: 'Unknown callback prefix' };
  }

  const parsed = verifyCallbackNonce(callbackData, fromChatId);
  if (!parsed) {
    await answerCallbackQuery(callbackQueryId, 'This button has expired. Please request a new settlement prompt.');
    return { success: false, error: 'Expired or invalid signature' };
  }

  const { predictionId, outcome } = parsed;
  const ownerRes = await query<{ user_id: string }>(
    'SELECT p.user_id FROM predictions p JOIN bot_links bl ON bl.user_id = p.user_id WHERE p.id = $1 AND bl.telegram_chat_id = $2;',
    [predictionId, fromChatId]
  );
  if (ownerRes.rows.length === 0) {
    await answerCallbackQuery(callbackQueryId, 'Unauthorized');
    return { success: false, unauthorized: true, error: 'Unauthorized' };
  }

  const userId = ownerRes.rows[0].user_id;
  const allowedOutcomes = ['WON', 'LOST', 'PUSH'];
  if (!allowedOutcomes.includes(outcome)) {
    await answerCallbackQuery(callbackQueryId, 'Invalid outcome');
    return { success: false, error: 'Invalid outcome' };
  }

  try {
    await settlePrediction({
      userId,
      predictionId,
      newOutcome: outcome as PredictionOutcome,
      source: 'MANUAL_USER',
      verification: 'SELF_REPORTED',
      evidenceJson: { source: 'telegram_callback', chatId: fromChatId },
    });
    await answerCallbackQuery(callbackQueryId, 'Recorded as ' + outcome + ' - self-reported');
    return { success: true, outcome };
  } catch (settleErr: unknown) {
    const msg = settleErr instanceof Error ? settleErr.message : String(settleErr);
    if (msg.includes('already resolved') || msg.includes('already settled')) {
      await answerCallbackQuery(callbackQueryId, 'Already settled.');
      return { success: false, alreadySettled: true, error: 'Already settled.' };
    }
    await answerCallbackQuery(callbackQueryId, 'Could not record result. Please use the app.');
    return { success: false, error: msg };
  }
}


