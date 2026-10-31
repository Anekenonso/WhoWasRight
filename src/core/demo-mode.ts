/**
 * Judge Demo Mode & Ephemeral Sandbox Isolation
 *
 * Implements:
 * 1. Anonymous, sign-in-free Judge Demo session creation with 60-minute TTL.
 * 2. Complete data isolation: demo records use an ephemeral demo user.
 * 3. Seeded sample analysts, predictions, and events for immediate evaluation.
 * 4. Deterministic credibility score calculations on sample data.
 * 5. Strict prevention of real user data exposure, Walrus Mainnet writes, or Telegram notifications.
 */

import { randomBytes } from 'node:crypto';
import { query, withTransaction } from './db.ts';
import { generateSessionToken, hashSessionToken } from './crypto.ts';
import type { UserRecord } from './auth.ts';

export interface DemoSessionResult {
  token: string;
  user: UserRecord;
  expiresAt: Date;
  isDemo: true;
}

/**
 * Creates an ephemeral demo session for an anonymous judge/visitor.
 * Fully isolated with negative synthetic Telegram ID and sample predictions.
 */
export async function createDemoSession(): Promise<DemoSessionResult> {
  const ttlMinutes = parseInt(process.env.DEMO_SESSION_TTL_MINUTES || '60', 10);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  // Negative synthetic Telegram ID avoids collision with real Telegram users
  const randomSuffix = Math.floor(100000 + Math.random() * 900000);
  const syntheticTelegramId = -1 * (Date.now() + randomSuffix);
  const username = `judge_demo_${randomBytes(4).toString('hex')}`;

  return withTransaction(async (client) => {
    // 1. Create Ephemeral Demo User
    const userRes = await client.query<UserRecord>(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, 'Judge Demo')
      RETURNING id, telegram_id, username, first_name, notifications_enabled, deleted_at, created_at;
    `, [syntheticTelegramId, username]);

    const user = userRes.rows[0];

    // 2. Create Ephemeral Session
    const plaintextToken = 'demo_' + generateSessionToken();
    const tokenHash = hashSessionToken(plaintextToken);

    await client.query(`
      INSERT INTO sessions (token_hash, user_id, expires_at)
      VALUES ($1, $2, $3);
    `, [tokenHash, user.id, expiresAt]);

    // 3. Pre-seed Sample Rated Analyst (Jamie Carragher)
    const aRes = await client.query<{ id: string }>(`
      INSERT INTO analysts (user_id, name)
      VALUES ($1, 'Jamie Carragher')
      RETURNING id;
    `, [user.id]);
    const carraId = aRes.rows[0].id;

    await client.query(`
      INSERT INTO analyst_aliases (analyst_id, platform, handle)
      VALUES ($1, 'TWITTER', '@Carra23');
    `, [carraId]);

    // Pre-seed an unrated analyst (Gary Neville) with no settled picks
    await client.query(`
      INSERT INTO analysts (user_id, name)
      VALUES ($1, 'Gary Neville');
    `, [user.id]);

    // 4. Pre-seed Sample Events & Predictions (>=6 settled picks: 4 WON, 2 LOST, 1 PENDING)
    // Outcome breakdown: 4 Won / 6 Decisive = 66.67% win rate (Good Tier, Limited Badge)

    // Event 1: Arsenal vs Chelsea (WON)
    const e1 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Arsenal vs Chelsea', NOW() - INTERVAL '2 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, '1X2', 'Arsenal', 'WON', 'SELF_REPORTED', NOW() - INTERVAL '2 days');
    `, [user.id, e1.rows[0].id, carraId]);

    // Event 2: Liverpool vs Man City (WON)
    const e2 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Liverpool vs Man City', NOW() - INTERVAL '3 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, 'OVER_UNDER_2_5', 'Over 2.5', 'WON', 'SELF_REPORTED', NOW() - INTERVAL '3 days');
    `, [user.id, e2.rows[0].id, carraId]);

    // Event 3: Real Madrid vs Barcelona (LOST)
    const e3 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Real Madrid vs Barcelona', NOW() - INTERVAL '4 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, '1X2', 'Barcelona', 'LOST', 'SELF_REPORTED', NOW() - INTERVAL '4 days');
    `, [user.id, e3.rows[0].id, carraId]);

    // Event 4: Bayern Munich vs Dortmund (WON)
    const e4 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Bayern Munich vs Dortmund', NOW() - INTERVAL '5 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, 'BTTS', 'Yes', 'WON', 'SELF_REPORTED', NOW() - INTERVAL '5 days');
    `, [user.id, e4.rows[0].id, carraId]);

    // Event 5: Inter Milan vs Juventus (LOST)
    const e5 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Inter Milan vs Juventus', NOW() - INTERVAL '6 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, '1X2', 'Juventus', 'LOST', 'SELF_REPORTED', NOW() - INTERVAL '6 days');
    `, [user.id, e5.rows[0].id, carraId]);

    // Event 6: PSG vs Marseille (WON)
    const e6 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'PSG vs Marseille', NOW() - INTERVAL '7 days', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, 'OVER_UNDER_2_5', 'Over 2.5', 'WON', 'SELF_REPORTED', NOW() - INTERVAL '7 days');
    `, [user.id, e6.rows[0].id, carraId]);

    // Event 7: Tottenham vs Newcastle (PENDING - future match)
    const e7 = await client.query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Tottenham vs Newcastle', NOW() + INTERVAL '2 hours', 'USER_REPORTED')
      RETURNING id;
    `, [user.id]);
    await client.query(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification, created_at)
      VALUES ($1, $2, $3, '1X2', 'Tottenham', 'PENDING', 'UNVERIFIED', NOW());
    `, [user.id, e7.rows[0].id, carraId]);

    return {
      token: plaintextToken,
      user,
      expiresAt,
      isDemo: true,
    };
  });
}

/**
 * Checks if a given user is an ephemeral demo user.
 */
export function isDemoUser(user: { telegram_id: number | string }): boolean {
  return Number(user.telegram_id) < 0;
}

/**
 * Cleans up expired demo sessions and their associated ephemeral user records.
 *
 * Scope:
 * - Only demo users with telegram_id < 0 are targeted.
 * - Real users (telegram_id > 0) are strictly excluded at the database query level.
 * - Deletes demo users where either:
 *   1. All associated sessions have expired (MAX(expires_at) < NOW()), OR
 *   2. No unexpired active sessions exist and user was created > 5 minutes ago.
 * - Cascading foreign keys on users(id) automatically clean up predictions, events,
 *   analysts, outbox records, and outcome events without leaving orphaned data.
 * - Operation is idempotent and safe to invoke repeatedly from cron/maintenance workers.
 */
export async function cleanupExpiredDemoSessions(): Promise<number> {
  const res = await query(`
    DELETE FROM users
    WHERE telegram_id < 0
      AND (
        id IN (
          SELECT user_id FROM sessions
          GROUP BY user_id
          HAVING MAX(expires_at) < NOW()
        )
        OR (
          created_at < NOW() - INTERVAL '5 minutes'
          AND NOT EXISTS (
            SELECT 1 FROM sessions s
            WHERE s.user_id = users.id AND s.expires_at > NOW()
          )
        )
      );
  `);
  return res.rowCount || 0;
}
