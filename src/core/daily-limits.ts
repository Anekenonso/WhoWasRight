/**
 * Daily Logging Limits (Advisory Soft Limits)
 *
 * Rules:
 * 1. Predictions 1-15: NORMAL (No warning).
 * 2. Predictions 16-24: WARNING (Gentle notification: "You've logged X predictions today. Take a breather!").
 * 3. Predictions 25+: ADVISORY ("High activity: X predictions logged today.").
 * 4. STRICT RULE: Never hard block saves! Always allow user to continue logging.
 * 5. Timezone Definition: Standard UTC calendar day (DATE_TRUNC('day', created_at_utc)).
 */

import { query } from './db.ts';

export type DailyLimitStatus = 'NORMAL' | 'WARNING' | 'ADVISORY';

export interface DailyLimitCheck {
  countToday: number;
  status: DailyLimitStatus;
  warningMessage?: string;
  canSave: true; // Invariant: saving is always permitted
}

/**
 * Counts predictions logged by user during the current UTC calendar day
 */
export async function getDailyPredictionCount(userId: string, targetDate = new Date()): Promise<number> {
  const startOfDay = new Date(Date.UTC(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth(),
    targetDate.getUTCDate(),
    0, 0, 0, 0
  ));
  const endOfDay = new Date(Date.UTC(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth(),
    targetDate.getUTCDate(),
    23, 59, 59, 999
  ));

  const res = await query<{ count: string }>(`
    SELECT count(*)::int AS count
    FROM predictions
    WHERE user_id = $1
      AND created_at_utc >= $2
      AND created_at_utc <= $3;
  `, [userId, startOfDay, endOfDay]);

  return parseInt(res.rows[0]?.count || '0', 10);
}

/**
 * Evaluates current daily activity against the soft warning thresholds
 *
 * Rules:
 * - Predictions 1–15: No warning (NORMAL).
 * - Beginning with the 16th prediction: Display a gentle warning (WARNING).
 * - At 25+ predictions: Continue allowing saves normally (ADVISORY).
 * - No hard limits: canSave is always true.
 * - Neutral helpful wording: "You've logged a lot of predictions today. Everything is still being saved normally."
 */
export function evaluateDailyLimit(countToday: number): DailyLimitCheck {
  const neutralMessage = "You've logged a lot of predictions today. Everything is still being saved normally.";

  if (countToday >= 25) {
    return {
      countToday,
      status: 'ADVISORY',
      warningMessage: neutralMessage,
      canSave: true,
    };
  }

  if (countToday >= 16) {
    return {
      countToday,
      status: 'WARNING',
      warningMessage: neutralMessage,
      canSave: true,
    };
  }

  return {
    countToday,
    status: 'NORMAL',
    canSave: true,
  };
}

/**
 * Combined check: queries DB and evaluates limit status
 */
export async function checkUserDailyLimit(userId: string): Promise<DailyLimitCheck> {
  const countToday = await getDailyPredictionCount(userId);
  return evaluateDailyLimit(countToday);
}

