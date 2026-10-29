/**
 * Telegram Authentication & Session Management
 *
 * Implements:
 * 1. Server-side validation of official Telegram Login Widget payload.
 * 2. HMAC-SHA256 signature verification using SHA-256(bot_token).
 * 3. Freshness checks (<24 hours, no future timestamps).
 * 4. User identity mapping and session creation with hashed tokens.
 * 5. Session resolution and strict user isolation.
 */

import { createHash, createHmac } from 'node:crypto';
import { query, withTransaction } from './db.ts';
import { generateSessionToken, hashSessionToken } from './crypto.ts';

export interface TelegramLoginData {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number | string;
  hash: string;
}

export interface UserRecord {
  id: string;
  telegram_id: number;
  username?: string;
  first_name?: string;
  notifications_enabled: boolean;
  deleted_at?: string;
  created_at: string;
}

export interface AuthSession {
  token: string;       // Plaintext bearer/cookie token returned to client
  tokenHash: string;   // SHA-256 stored in DB
  user: UserRecord;
  expiresAt: Date;
}

/**
 * Validates Telegram Login Widget payload per official Telegram specifications
 */
export function verifyTelegramLoginPayload(
  payload: Record<string, string | number | undefined>,
  botToken?: string
): { valid: boolean; reason?: string; user?: TelegramLoginData } {
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { valid: false, reason: 'TELEGRAM_BOT_TOKEN not configured' };
  }

  const { hash, ...dataFields } = payload;
  if (!hash || typeof hash !== 'string') {
    return { valid: false, reason: 'Missing cryptographic hash' };
  }

  // 1. Check timestamp freshness (<24 hours)
  const authDate = Number(dataFields.auth_date);
  if (isNaN(authDate)) {
    return { valid: false, reason: 'Invalid or missing auth_date' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (authDate > nowSec + 120) { // allow 2 min clock skew
    return { valid: false, reason: 'auth_date is in the future' };
  }
  if (nowSec - authDate > 86400) {
    return { valid: false, reason: 'Payload has expired (older than 24 hours)' };
  }

  // 2. Build sorted data-check-string
  const checkString = Object.keys(dataFields)
    .filter(k => dataFields[k] !== undefined && dataFields[k] !== null && dataFields[k] !== '')
    .sort()
    .map(k => `${k}=${dataFields[k]}`)
    .join('\n');

  // 3. Compute secret key = SHA-256(bot_token)
  const secretKey = createHash('sha256').update(token).digest();

  // 4. Compute expected hash = HMAC-SHA256(dataCheckString, secretKey)
  const expectedHash = createHmac('sha256', secretKey)
    .update(checkString)
    .digest('hex');

  if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
    return { valid: false, reason: 'Cryptographic hash mismatch (tampered payload)' };
  }

  return {
    valid: true,
    user: payload as unknown as TelegramLoginData,
  };
}

/**
 * Upserts user record based on verified Telegram ID and creates a new session
 */
export async function authenticateTelegramUser(
  data: TelegramLoginData,
  sessionTtlDays = 30
): Promise<AuthSession> {
  const telegramId = Number(data.id);
  const username = data.username || null;
  const firstName = data.first_name || null;

  return withTransaction(async (client) => {
    // 1. Upsert User
    const userRes = await client.query<UserRecord>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_id) DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        deleted_at = NULL, -- Reactivate if previously deleted
        updated_at = NOW()
      RETURNING id, telegram_id, username, first_name, notifications_enabled, deleted_at, created_at;
    `, [telegramId, username, firstName]);

    const user = userRes.rows[0];

    // 2. Generate Session Token & Hash
    const plaintextToken = generateSessionToken();
    const tokenHash = hashSessionToken(plaintextToken);
    const expiresAt = new Date(Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000);

    // 3. Store Session
    await client.query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3);
    `, [tokenHash, user.id, expiresAt]);

    return {
      token: plaintextToken,
      tokenHash,
      user,
      expiresAt,
    };
  });
}

/**
 * Validates session token and returns authenticated user record
 */
export async function getSessionUser(token: string): Promise<UserRecord | null> {
  if (!token || typeof token !== 'string') return null;

  const tokenHash = hashSessionToken(token);
  const res = await query<UserRecord>(`
    SELECT u.id, u.telegram_id, u.username, u.first_name, u.notifications_enabled, u.deleted_at, u.created_at
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW()
      AND u.deleted_at IS NULL;
  `, [tokenHash]);

  return res.rows[0] || null;
}

/**
 * Revokes a session (Sign out)
 */
export async function revokeSession(token: string): Promise<boolean> {
  const tokenHash = hashSessionToken(token);
  const res = await query(`
    DELETE FROM sessions WHERE token_hash = $1;
  `, [tokenHash]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * Soft deletes user and revokes all active sessions
 */
export async function deleteUserAccount(userId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    // 1. Delete all sessions
    await client.query('DELETE FROM sessions WHERE user_id = $1;', [userId]);
    // 2. Soft-delete user
    const res = await client.query(`
      UPDATE users SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL;
    `, [userId]);
    return (res.rowCount ?? 0) > 0;
  });
}

