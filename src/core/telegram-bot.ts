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
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!botUsername) throw new Error('TELEGRAM_BOT_USERNAME not configured');

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

/**
 * Generates an HMAC-signed nonce for Telegram inline button callback data.
 * Format: `settle:{predictionId}:{outcome}:{chatId}:{timestamp}:{hmac}`
 */
export function generateCallbackNonce(params: {
  predictionId: string;
  outcome: string;
  chatId: number;
}): string {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) throw new Error('TELEGRAM_WEBHOOK_SECRET not configured');
  const { predictionId, outcome, chatId } = params;
  const timestamp = Date.now();
  const message = `${predictionId}:${outcome}:${chatId}:${timestamp}`;
  const hmac = createHmac('sha256', secret).update(message).digest('hex').substring(0, 16);
  return `settle:${predictionId}:${outcome}:${chatId}:${timestamp}:${hmac}`;
}

/**
 * Verifies a callback nonce from an inline button press.
 * Returns parsed fields if valid, null if invalid or expired.
 */
export function verifyCallbackNonce(
  callbackData: string,
  fromChatId: number
): { predictionId: string; outcome: string } | null {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret) return null;

  const parts = callbackData.split(':');
  if (parts.length !== 6 || parts[0] !== 'settle') return null;

  const [, predictionId, outcome, chatIdStr, timestampStr, receivedHmac] = parts;
  const chatId = Number(chatIdStr);
  const timestamp = Number(timestampStr);

  // Verify chat_id matches the sender
  if (chatId !== fromChatId) return null;

  // Verify not expired
  if (Date.now() - timestamp > CALLBACK_NONCE_TTL_MS) return null;

  // Re-compute HMAC
  const message = `${predictionId}:${outcome}:${chatId}:${timestamp}`;
  const expectedHmac = createHmac('sha256', secret).update(message).digest('hex').substring(0, 16);

  if (receivedHmac !== expectedHmac) return null;

  return { predictionId, outcome };
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

async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
 * Processes pending notifications from the queue.
 * Call from the cron endpoint after settlement.
 * Respects Telegram rate limits; marks blocked/deleted chats as BLOCKED.
 */
export async function processNotificationQueue(maxItems = 20): Promise<{
  sent: number;
  failed: number;
  blocked: number;
}> {
  const stats = { sent: 0, failed: 0, blocked: 0 };

  const pendingRes = await query<{
    id: string;
    user_id: string;
    prediction_id: string;
    notification_type: string;
    payload_json: any;
    attempts: number;
  }>(
    `SELECT nq.id, nq.user_id, nq.prediction_id, nq.notification_type, nq.payload_json, nq.attempts
     FROM notification_queue nq
     WHERE nq.status = 'PENDING'
       AND nq.next_retry_at <= NOW()
     ORDER BY nq.created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED;`,
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
      await query(`UPDATE notification_queue SET status = 'SENDING', updated_at = NOW() WHERE id = $1;`, [item.id]);

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
  const emoji = outcome === 'WON' ? '✅' : outcome === 'LOST' ? '❌' : '↩️';
  const appUrl = process.env.APP_BASE_URL ?? '';

  const text =
    `${emoji} *Result Verified*\n\n` +
    `*Match:* ${escapeMarkdown(payload.eventName)}\n` +
    `*Analyst:* ${escapeMarkdown(payload.analystName)}\n` +
    `*Pick:* ${escapeMarkdown(payload.market)} — ${escapeMarkdown(payload.selection)}\n` +
    `*Result:* *${outcome}*\n` +
    `*Score:* ${escapeMarkdown(payload.score ?? '—')}\n` +
    `*Evidence:* ${escapeMarkdown(payload.reason ?? '—')}\n\n` +
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

  if (!callbackData.startsWith('settle:')) {
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


