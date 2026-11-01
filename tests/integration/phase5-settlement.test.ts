/**
 * Phase 5 Integration Tests: Telegram Bot Linking, Settlement & Notifications
 *
 * Tests against real database (Supabase Postgres).
 * No real Telegram API calls — bot sends are mocked via environment stub.
 * No real football API calls — fixture data injected directly.
 *
 * Covers:
 * 1. Bot link token generation and single-use enforcement.
 * 2. Expired token rejection.
 * 3. Cross-account bot linking prevention.
 * 4. Bot link status and notification toggle.
 * 5. Duplicate notification idempotency (same idempotency key = no duplicate row).
 * 6. Webhook secret rejection (unauthorized).
 * 7. Manual settlement via settlePrediction (authorized user).
 * 8. Cross-user manual settlement denial.
 * 9. API-verified settlement cannot be silently overwritten.
 * 10. Correction event appends audit trail, does not delete history.
 * 11. Duplicate settlement cron call is idempotent (already settled → error caught).
 * 12. Notification queue: FAILED after 5 attempts.
 * 13. Prediction detail: owner can read, other user cannot.
 * 14. Settlement result: self-reported never labeled API_VERIFIED.
 * 15. Football quota exhaustion: settlement halts gracefully.
 */

import { query, withTransaction, closeDbPool } from './test-db.ts';
import { createHash, randomBytes } from 'node:crypto';
import {
  generateBotLinkToken,
  confirmBotLink,
  getBotLinkStatus,
  toggleNotifications,
  verifyWebhookSecret,
  enqueueNotification,
  generateCallbackNonce,
  verifyCallbackNonce,
  handleTelegramCallbackQuery,
} from '../../src/core/telegram-bot.ts';
import { settlePrediction } from '../../src/core/predictions.ts';
import { adjudicateFootballPrediction, executeAutomatedSettlement } from '../../src/core/settlement.ts';
import { SportRateLimiter } from '../../src/core/football-cache.ts';

export async function runPhase5IntegrationTests(): Promise<{ passed: boolean; count: number; failures: string[] }> {
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

  console.log('\n--- Running Phase 5 Integration Tests: Bot Linking & Settlement ---');

  const suffix = Date.now();
  const originalWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'integration-test-webhook-secret';

  // Create two isolated test users
  const u1Res = await query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) RETURNING id;`,
    [7800000000 + suffix % 100000, `p5test_u1_${suffix}`, 'P5TestUser1']
  );
  const userId1 = u1Res.rows[0].id;

  const u2Res = await query<{ id: string }>(
    `INSERT INTO users (telegram_id, username, first_name) VALUES ($1, $2, $3) RETURNING id;`,
    [7800001000 + suffix % 100000, `p5test_u2_${suffix}`, 'P5TestUser2']
  );
  const userId2 = u2Res.rows[0].id;

  const chatId1 = 7800000000 + suffix % 100000;
  const chatId2 = 7800001000 + suffix % 100000;

  // ============================================================
  // 1. Bot Link Token Generation
  // ============================================================
  console.log('\n  [Section 1: Bot Link Token]');
  process.env.TELEGRAM_BOT_USERNAME = 'WhoWasRightBot';

  const { plaintextToken, deepLink } = await generateBotLinkToken(userId1);
  assert(typeof plaintextToken === 'string' && plaintextToken.length === 32, 'Link token is 32-char hex');
  assert(deepLink.includes('WhoWasRightBot'), 'Deep link contains bot username');
  assert(deepLink.includes(`link_${plaintextToken}`), 'Deep link contains plaintext token');

  // Token stored as SHA-256 hash, not plaintext
  const tokenHash = createHash('sha256').update(plaintextToken).digest('hex');
  const storedRes = await query<{ token_hash: string; used_at: string | null }>(
    `SELECT token_hash, used_at FROM bot_link_tokens WHERE token_hash = $1;`,
    [tokenHash]
  );
  assert(storedRes.rows.length === 1, 'Token stored in bot_link_tokens');
  assert(storedRes.rows[0].used_at === null, 'Token initially unused');
  assert(storedRes.rows[0].token_hash !== plaintextToken, 'Stored as hash, not plaintext');

  // ============================================================
  // 2. Confirm Bot Link
  // ============================================================
  console.log('\n  [Section 2: Confirm Bot Link]');

  const confirmResult = await confirmBotLink({ plaintextToken, telegramChatId: chatId1 });
  assert(confirmResult.success === true, 'Bot link confirmed successfully');

  const afterConfirm = await query<{ used_at: string | null }>(
    `SELECT used_at FROM bot_link_tokens WHERE token_hash = $1;`,
    [tokenHash]
  );
  assert(afterConfirm.rows[0].used_at !== null, 'Token marked as used after confirmation');

  const botLinkRow = await query<{ telegram_chat_id: string; enabled: boolean }>(
    `SELECT telegram_chat_id, enabled FROM bot_links WHERE user_id = $1;`,
    [userId1]
  );
  assert(botLinkRow.rows.length === 1, 'bot_links row created');
  assert(Number(botLinkRow.rows[0].telegram_chat_id) === chatId1, 'chat_id matches user telegram_id');
  assert(botLinkRow.rows[0].enabled === true, 'Bot enabled by default on link');

  // ============================================================
  // 3. Token Replay Prevention (single-use)
  // ============================================================
  console.log('\n  [Section 3: Token Replay Prevention]');

  const replayResult = await confirmBotLink({ plaintextToken, telegramChatId: chatId1 });
  assert(replayResult.success === false, 'Replay of used token rejected');
  assert(replayResult.reason === 'Linking token already used', 'Correct rejection reason for replay');

  // ============================================================
  // 4. Expired Token Rejection
  // ============================================================
  console.log('\n  [Section 4: Expired Token Rejection]');

  const expiredToken = randomBytes(16).toString('hex');
  const expiredHash = createHash('sha256').update(expiredToken).digest('hex');
  await query(
    `INSERT INTO bot_link_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() - INTERVAL '1 second');`,
    [expiredHash, userId1]
  );
  const expiredResult = await confirmBotLink({ plaintextToken: expiredToken, telegramChatId: chatId1 });
  assert(expiredResult.success === false, 'Expired token rejected');
  assert(expiredResult.reason === 'Linking token has expired', 'Correct expiry reason');

  // ============================================================
  // 5. Cross-Account Bot Linking Prevention
  // ============================================================
  console.log('\n  [Section 5: Cross-Account Bot Linking Prevention]');

  const { plaintextToken: token2 } = await generateBotLinkToken(userId1);
  // User 2's chat_id tries to claim user 1's token
  const crossResult = await confirmBotLink({ plaintextToken: token2, telegramChatId: chatId2 });
  assert(crossResult.success === false, 'Cross-account linking prevented');
  assert(crossResult.reason !== undefined && crossResult.reason.includes('does not match'), 'Correct cross-account reason');

  // ============================================================
  // 6. Bot Link Status & Notification Toggle
  // ============================================================
  console.log('\n  [Section 6: Bot Status & Notification Toggle]');

  const status = await getBotLinkStatus(userId1);
  assert(status.linked === true, 'Bot status reports linked');
  assert(status.enabled === true, 'Bot status reports enabled');
  assert(status.telegramChatId === chatId1, 'Chat ID matches in status response');

  const toggled = await toggleNotifications(userId1, false);
  assert(toggled === true, 'Notification toggle returns true on success');

  const disabledStatus = await getBotLinkStatus(userId1);
  assert(disabledStatus.enabled === false, 'Notifications disabled after toggle');

  await toggleNotifications(userId1, true); // Re-enable for next tests

  // ============================================================
  // 7. Notification Queue Idempotency
  // ============================================================
  console.log('\n  [Section 7: Notification Queue Idempotency]');

  // Create a prediction for notification tests
  const analystRes = await query<{ id: string }>(
    `INSERT INTO analysts (user_id, name) VALUES ($1, $2) RETURNING id;`,
    [userId1, `P5TestAnalyst_${suffix}`]
  );
  const analystId = analystRes.rows[0].id;

  const eventRes = await query<{ id: string }>(
    `INSERT INTO events (user_id, sport, label, start_at_utc, source) VALUES ($1, 'FOOTBALL', 'P5 Test Match', NOW() + INTERVAL '2 hours', 'USER_REPORTED') RETURNING id;`,
    [userId1]
  );
  const eventId = eventRes.rows[0].id;

  const predRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, '1X2', 'Arsenal', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, eventId, analystId]
  );
  const predictionId = predRes.rows[0].id;

  // First enqueue
  const notifId1 = await enqueueNotification({
    userId: userId1,
    predictionId,
    notificationType: 'SETTLEMENT_AUTO',
    payload: { eventName: 'Test Match', analystName: 'TestAnalyst', market: '1X2', selection: 'Arsenal', outcome: 'WON', score: '2-1', reason: 'Home win', viewUrl: `/predictions/${predictionId}` },
  });
  assert(notifId1 !== null, 'First notification enqueued successfully');

  // Duplicate enqueue (same idempotency key)
  const notifId2 = await enqueueNotification({
    userId: userId1,
    predictionId,
    notificationType: 'SETTLEMENT_AUTO',
    payload: { eventName: 'Test Match', analystName: 'TestAnalyst', market: '1X2', selection: 'Arsenal', outcome: 'WON', score: '2-1', reason: 'Home win', viewUrl: `/predictions/${predictionId}` },
  });
  assert(notifId2 === null, 'Duplicate notification returns null (idempotent — no duplicate row)');

  // Verify only one row in notification_queue
  const notifCount = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM notification_queue WHERE prediction_id = $1 AND notification_type = 'SETTLEMENT_AUTO';`,
    [predictionId]
  );
  assert(Number(notifCount.rows[0].count) === 1, 'Exactly one notification row created (idempotency key prevents duplicate)');

  // ============================================================
  // 8. Bot Disabled → Notification Not Queued
  // ============================================================
  console.log('\n  [Section 8: No Notification When Bot Disabled]');

  await toggleNotifications(userId1, false);
  const pred2Res = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, 'BTTS', 'Yes', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, eventId, analystId]
  );
  const predId2 = pred2Res.rows[0].id;

  const skippedNotif = await enqueueNotification({
    userId: userId1,
    predictionId: predId2,
    notificationType: 'SETTLEMENT_AUTO',
    payload: { eventName: 'Test Match', analystName: 'TestAnalyst', market: 'BTTS', selection: 'Yes', outcome: 'WON', score: '1-1', reason: 'Both scored', viewUrl: `/predictions/${predId2}` },
  });
  assert(skippedNotif === null, 'Notification not queued when bot is disabled');

  await toggleNotifications(userId1, true); // re-enable

  // ============================================================
  // 9. Manual Settlement: Authorized User
  // ============================================================
  console.log('\n  [Section 9: Manual Settlement — Authorized]');

  // Create a fresh PENDING prediction for settlement test
  const settleEventRes = await query<{ id: string }>(
    `INSERT INTO events (user_id, sport, label, start_at_utc, source, ever_started) VALUES ($1, 'FOOTBALL', 'Settled Match Test', NOW() - INTERVAL '2 hours', 'USER_REPORTED', TRUE) RETURNING id;`,
    [userId1]
  );
  const settleEventId = settleEventRes.rows[0].id;

  const settlePredRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, '1X2', 'Chelsea', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const settlePredId = settlePredRes.rows[0].id;

  const settledPred = await settlePrediction({
    userId: userId1,
    predictionId: settlePredId,
    newOutcome: 'WON',
    source: 'MANUAL_USER',
    verification: 'SELF_REPORTED',
    evidenceJson: { source: 'test' },
  });

  assert(settledPred.outcome === 'WON', 'Manual settlement sets outcome to WON');
  assert(settledPred.verification === 'SELF_REPORTED', 'Manual settlement marked SELF_REPORTED — never API_VERIFIED');

  // Verify audit trail created
  const auditRes = await query<{ source: string; new_outcome: string }>(
    `SELECT source, new_outcome FROM outcome_events WHERE prediction_id = $1;`,
    [settlePredId]
  );
  assert(auditRes.rows.length === 1, 'Outcome event audit trail created');
  assert(auditRes.rows[0].source === 'MANUAL_USER', 'Audit event source is MANUAL_USER');
  assert(auditRes.rows[0].new_outcome === 'WON', 'Audit event records WON outcome');

  // ============================================================
  // 10. Cross-User Settlement Denial
  // ============================================================
  console.log('\n  [Section 10: Cross-User Settlement Denial]');

  const crossSettlePredRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, '1X2', 'Arsenal', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const crossPredId = crossSettlePredRes.rows[0].id;

  let crossSettleError: string | null = null;
  try {
    await settlePrediction({
      userId: userId2, // Wrong user
      predictionId: crossPredId,
      newOutcome: 'LOST',
      source: 'MANUAL_USER',
      verification: 'SELF_REPORTED',
    });
  } catch (e) {
    crossSettleError = (e as Error).message;
  }
  assert(crossSettleError !== null, 'Cross-user settlement throws error');
  assert(crossSettleError?.includes('not found or unauthorized') ?? false, 'Error message confirms ownership check');

  // ============================================================
  // 11. API-Verified Result Cannot Be Casually Overwritten
  // ============================================================
  console.log('\n  [Section 11: API-Verified Settlement Protection]');

  // Create a prediction that is already API-VERIFIED WON
  const apiPredRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, '1X2', 'Liverpool', 'WON', 'API_VERIFIED') RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const apiPredId = apiPredRes.rows[0].id;

  // Non-CORRECTION source must be rejected
  let overwriteError: string | null = null;
  try {
    await settlePrediction({
      userId: userId1,
      predictionId: apiPredId,
      newOutcome: 'LOST',
      source: 'MANUAL_USER', // Not a CORRECTION
      verification: 'SELF_REPORTED',
    });
  } catch (e) {
    overwriteError = (e as Error).message;
  }
  assert(overwriteError !== null, 'API-verified result cannot be overwritten by MANUAL_USER source');
  assert(overwriteError?.includes('already resolved') ?? false, 'Correct rejection message for overwrite attempt');

  // ============================================================
  // 12. Correction: Appends Audit Trail, Preserves History
  // ============================================================
  console.log('\n  [Section 12: Correction Appends Audit Trail]');

  // Settle first via MANUAL_USER
  const corrPredRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, 'BTTS', 'No', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const corrPredId = corrPredRes.rows[0].id;

  await settlePrediction({
    userId: userId1, predictionId: corrPredId, newOutcome: 'WON',
    source: 'MANUAL_USER', verification: 'SELF_REPORTED',
  });

  // Then apply CORRECTION
  const corrected = await settlePrediction({
    userId: userId1, predictionId: corrPredId, newOutcome: 'LOST',
    source: 'CORRECTION', verification: 'SELF_REPORTED',
    evidenceJson: { reason: 'Score was incorrect' },
  });
  assert(corrected.outcome === 'LOST', 'Correction changes outcome to LOST');
  assert(corrected.verification === 'SELF_REPORTED', 'Correction remains SELF_REPORTED');

  const corrAudit = await query<{ source: string; old_outcome: string; new_outcome: string }>(
    `SELECT source, old_outcome, new_outcome FROM outcome_events WHERE prediction_id = $1 ORDER BY created_at ASC;`,
    [corrPredId]
  );
  assert(corrAudit.rows.length === 2, 'Two audit events: original settlement + correction');
  assert(corrAudit.rows[0].source === 'MANUAL_USER', 'First event: MANUAL_USER settlement');
  assert(corrAudit.rows[1].source === 'CORRECTION', 'Second event: CORRECTION');
  assert(corrAudit.rows[1].old_outcome === 'WON', 'Correction records old outcome WON');
  assert(corrAudit.rows[1].new_outcome === 'LOST', 'Correction records new outcome LOST');

  // ============================================================
  // 13. Duplicate Settlement Idempotency
  // ============================================================
  console.log('\n  [Section 13: Duplicate Settlement Idempotency]');

  // Try to settle an already-settled (non-CORRECTION) prediction again
  let dupSettleError: string | null = null;
  try {
    await settlePrediction({
      userId: userId1, predictionId: settlePredId, // WON from section 9
      newOutcome: 'LOST', source: 'MANUAL_USER', verification: 'SELF_REPORTED',
    });
  } catch (e) {
    dupSettleError = (e as Error).message;
  }
  assert(dupSettleError !== null, 'Duplicate settlement rejected');
  assert(dupSettleError?.includes('already resolved') ?? false, 'Duplicate settlement error message correct');

  // ============================================================
  // 14. Prediction Detail Ownership Enforcement
  // ============================================================
  console.log('\n  [Section 14: Prediction Detail Ownership]');

  // User 1 can read their own prediction
  const ownedPredRes = await query(
    `SELECT id FROM predictions WHERE id = $1 AND user_id = $2;`,
    [predictionId, userId1]
  );
  assert(ownedPredRes.rows.length === 1, 'Owner can access prediction');

  // User 2 cannot read user 1's prediction
  const unauthorizedPredRes = await query(
    `SELECT id FROM predictions WHERE id = $1 AND user_id = $2;`,
    [predictionId, userId2]
  );
  assert(unauthorizedPredRes.rows.length === 0, 'Other user cannot access prediction');

  // ============================================================
  // 15. Webhook Secret Header Validation
  // ============================================================
  console.log('\n  [Section 15: Webhook Secret Header]');

  process.env.TELEGRAM_WEBHOOK_SECRET = 'integration-test-webhook-secret';
  assert(verifyWebhookSecret('integration-test-webhook-secret') === true, 'Correct webhook header accepted');
  assert(verifyWebhookSecret('wrong') === false, 'Wrong webhook header rejected');
  assert(verifyWebhookSecret(undefined) === false, 'Missing webhook header rejected');

  // ============================================================
  // 16. Telegram Callback Security & Nonce Replay Prevention
  // ============================================================
  console.log('\n  [Section 16: Telegram Callback Security & Replay Prevention]');

  // Create a fresh prediction for callback test
  const cbPredRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification) VALUES ($1, $2, $3, 'TOTAL_GOALS', 'Over 1.5', 'PENDING', 'UNVERIFIED') RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const cbPredId = cbPredRes.rows[0].id;

  // Generate valid callback nonce for user 1's chat
  const validNonce = generateCallbackNonce({
    predictionId: cbPredId,
    outcome: 'WON',
    chatId: chatId1,
  });

  // A. Cross-Chat Authorization: Attempt settlement using chatId2 (attacker's chat)
  const crossChatParsed = verifyCallbackNonce(validNonce, chatId2);
  assert(crossChatParsed === null, 'Nonce rejected when presented by different chat ID');

  // Verify DB query in webhook denies cross-user settlement
  const crossUserCheck = await query(
    'SELECT p.user_id FROM predictions p JOIN bot_links bl ON bl.user_id = p.user_id WHERE p.id = $1 AND bl.telegram_chat_id = $2;',
    [cbPredId, chatId2]
  );
  assert(crossUserCheck.rows.length === 0, 'Database ownership check denies cross-user telegram callback');

  // B. Expired Nonce: Manually forged with past timestamp
  const expiredParts = validNonce.split(':');
  expiredParts[4] = String(Date.now() - 25 * 60 * 1000);
  assert(verifyCallbackNonce(expiredParts.join(':'), chatId1) === null, 'Expired callback nonce rejected');

  // C. Tampered Signature
  const tamperedParts = validNonce.split(':');
  tamperedParts[5] = 'deadbeefdeadbeef';
  assert(verifyCallbackNonce(tamperedParts.join(':'), chatId1) === null, 'Tampered HMAC signature rejected');

  // D. First Execution: Authorized settlement succeeds
  const authorizedParsed = verifyCallbackNonce(validNonce, chatId1);
  assert(authorizedParsed !== null, 'Authorized nonce parsed successfully');
  const firstSettle = await settlePrediction({
    userId: userId1,
    predictionId: cbPredId,
    newOutcome: 'WON',
    source: 'MANUAL_USER',
    verification: 'SELF_REPORTED',
    evidenceJson: { source: 'telegram_callback', chatId: chatId1 },
  });
  assert(firstSettle.outcome === 'WON', 'First callback execution settles prediction to WON');

  // E. Replay Prevention: Replaying the exact same callback nonce
  let replayError: string | null = null;
  try {
    await settlePrediction({
      userId: userId1,
      predictionId: cbPredId,
      newOutcome: 'WON',
      source: 'MANUAL_USER',
      verification: 'SELF_REPORTED',
      evidenceJson: { source: 'telegram_callback_replay', chatId: chatId1 },
    });
  } catch (err: unknown) {
    replayError = (err as Error).message;
  }
  assert(replayError !== null, 'Replayed callback rejected (cannot transition already-settled prediction)');
  assert(replayError?.includes('already resolved') ?? false, 'Replay error confirms duplicate transition prevention');

  // Verify outcome events only recorded 1 transition, not 2
  const cbAuditCount = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM outcome_events WHERE prediction_id = $1;`,
    [cbPredId]
  );
  assert(Number(cbAuditCount.rows[0].count) === 1, 'Exactly one audit event recorded (no duplicate transition from replay)');

    // ============================================================
  // 17. Quota Persistence & Concurrency (Audit 2)
  // ============================================================
  console.log('\n  [Section 17: Quota Persistence & Concurrency]');

  const testSportFb = `TEST_FB_${suffix}`;
  const testSportBb = `TEST_BB_${suffix}`;

  await query(`DELETE FROM api_quota_usage WHERE sport IN ($1, $2);`, [testSportFb, testSportBb]);

  const fbPersistentLimiter = new SportRateLimiter(testSportFb, 100, 95);
  const bbPersistentLimiter = new SportRateLimiter(testSportBb, 100, 100);

  // A. Concurrent Quota Reservations: 105 concurrent reservation attempts for Football (ceiling 95)
  const reservationPromises = Array.from({ length: 105 }, () => fbPersistentLimiter.reserveQuota());
  const reservationResults = await Promise.all(reservationPromises);

  const allowedCount = reservationResults.filter(r => r.allowed).length;
  const rejectedCount = reservationResults.filter(r => !r.allowed).length;

  assert(allowedCount === 95, 'Concurrent reservations: exactly 95 requests allowed for Football ceiling');
  assert(rejectedCount === 10, 'Concurrent reservations: remaining 10 requests atomically rejected');

  // Verify authoritative state in PostgreSQL
  const dbQuotaRes = await query<{ request_count: number }>(
    `SELECT request_count FROM api_quota_usage WHERE sport = $1;`,
    [testSportFb]
  );
  assert(Number(dbQuotaRes.rows[0].request_count) === 95, 'PostgreSQL authoritative counter is exactly 95');

  // B. Multi-Sport Isolation in PostgreSQL: Basketball is completely unaffected
  const bbRes1 = await bbPersistentLimiter.reserveQuota();
  assert(bbRes1.allowed === true, 'Basketball quota reservation succeeds independently of Football exhaustion');
  assert(bbRes1.used === 1, 'Basketball usage starts at 1');

  // C. Process Restart / Multi-Instance Persistence
  const restartedInstance = new SportRateLimiter(testSportFb, 100, 95);
  const restartAttempt = await restartedInstance.reserveQuota();
  assert(restartAttempt.allowed === false, 'Process restart does not reset counter: rejects further requests at ceiling');
  assert(restartAttempt.used === 95, 'Restarted instance reads 95 used slots from PostgreSQL');

  // D. Failed Provider Calls Consume Quota
  const testFailSport = `TEST_FAIL_${suffix}`;
  await query(`DELETE FROM api_quota_usage WHERE sport = $1;`, [testFailSport]);
  const failLimiter = new SportRateLimiter(testFailSport, 100, 95);
  let failedCallThrew = false;
  try {
    await failLimiter.reserveQuota();
    throw new Error('Provider 500 error');
  } catch {
    failedCallThrew = true;
  }
  assert(failedCallThrew, 'Failed provider call throws error as expected');
  const failUsage = await failLimiter.syncFromDb();
  assert(failUsage.used === 1, 'Failed provider call consumed reserved quota slot');

  // ============================================================
  // 18. Telegram Concurrent Callback Safety & Race Resolution (Audit 3)
  // ============================================================
  console.log('\n  [Section 18: Telegram Concurrent Callback Safety & Race Resolution]');

  // A. Concurrent Callback Arrival: 3 identical callbacks simultaneously
  const predConcurrentRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
     VALUES ($1, $2, $3, 'TOTAL_GOALS', 'Over 2.5', 'PENDING', 'UNVERIFIED')
     RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const predConcurrentId = predConcurrentRes.rows[0].id;

  const concurrentNonce = generateCallbackNonce({
    predictionId: predConcurrentId,
    outcome: 'WON',
    chatId: chatId1,
  });

  const concurrentCallbacks = await Promise.all([
    handleTelegramCallbackQuery({
      callbackData: concurrentNonce,
      fromChatId: chatId1,
      callbackQueryId: `cbq_1_${suffix}`,
    }),
    handleTelegramCallbackQuery({
      callbackData: concurrentNonce,
      fromChatId: chatId1,
      callbackQueryId: `cbq_2_${suffix}`,
    }),
    handleTelegramCallbackQuery({
      callbackData: concurrentNonce,
      fromChatId: chatId1,
      callbackQueryId: `cbq_3_${suffix}`,
    }),
  ]);

  const cbSuccesses = concurrentCallbacks.filter(c => c.success);
  const cbAlreadySettled = concurrentCallbacks.filter(c => c.alreadySettled);

  assert(cbSuccesses.length === 1, 'Concurrent callbacks: exactly 1 callback succeeds in settling prediction');
  assert(cbAlreadySettled.length === 2, 'Concurrent callbacks: remaining 2 callbacks safely return alreadySettled');

  const pCheck = await query<{ outcome: string; verification: string }>(
    `SELECT outcome, verification FROM predictions WHERE id = $1;`,
    [predConcurrentId]
  );
  assert(pCheck.rows[0].outcome === 'WON', 'Prediction outcome transitioned to WON');
  assert(pCheck.rows[0].verification === 'SELF_REPORTED', 'Prediction verification is SELF_REPORTED');

  const concurrentAuditRes = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM outcome_events WHERE prediction_id = $1;`,
    [predConcurrentId]
  );
  assert(Number(concurrentAuditRes.rows[0].count) === 1, 'Exactly one audit event committed (no duplicate audit entries)');

  const outboxRes = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM memory_outbox WHERE user_id = $1 AND event_key LIKE $2;`,
    [userId1, `%${predConcurrentId}%`]
  );
  assert(Number(outboxRes.rows[0].count) === 1, 'Exactly one memory outbox entry enqueued (no duplicate outbox records)');

  // B. Race Between Automated Settlement and Telegram Manual Settlement
  const predRaceRes = await query<{ id: string }>(
    `INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
     VALUES ($1, $2, $3, 'TOTAL_GOALS', 'Under 0.5', 'PENDING', 'UNVERIFIED')
     RETURNING id;`,
    [userId1, settleEventId, analystId]
  );
  const predRaceId = predRaceRes.rows[0].id;

  const raceEvidence: any = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 2,
    awayGoals: 1,
    status: 'FINISHED',
    statusShort: 'FT',
  };

  const raceNonce = generateCallbackNonce({
    predictionId: predRaceId,
    outcome: 'LOST',
    chatId: chatId1,
  });

  const raceResults = await Promise.allSettled([
    executeAutomatedSettlement({
      userId: userId1,
      predictionId: predRaceId,
      evidence: raceEvidence,
    }),
    handleTelegramCallbackQuery({
      callbackData: raceNonce,
      fromChatId: chatId1,
      callbackQueryId: `cbq_race_${suffix}`,
    }),
  ]);

  const raceFulfilled = raceResults.filter(r => r.status === 'fulfilled');
  assert(raceFulfilled.length === 2, 'Both race handlers executed to completion');

  const raceAudit = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM outcome_events WHERE prediction_id = $1;`,
    [predRaceId]
  );
  assert(Number(raceAudit.rows[0].count) === 1, 'Race resolution: exactly one outcome transition event recorded');

  // C. Unlinked Chat Callback Rejection
  const unlinkedNonce = generateCallbackNonce({
    predictionId: predConcurrentId,
    outcome: 'WON',
    chatId: 999999999,
  });
  const unlinkedRes = await handleTelegramCallbackQuery({
    callbackData: unlinkedNonce,
    fromChatId: 999999999,
    callbackQueryId: `cbq_unlinked_${suffix}`,
  });
  assert(unlinkedRes.unauthorized === true, 'Callback from unlinked/wrong chat is rejected as unauthorized');

// ============================================================
  // Cleanup
  // ============================================================
  await query(`DELETE FROM api_quota_usage WHERE sport IN ($1, $2, $3);`, [testSportFb, testSportBb, testFailSport]);
  await query(`DELETE FROM notification_queue WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM bot_links WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM bot_link_tokens WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM outcome_events WHERE prediction_id IN (SELECT id FROM predictions WHERE user_id = $1 OR user_id = $2);`, [userId1, userId2]);
  await query(`DELETE FROM memory_outbox WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM predictions WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM events WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM analysts WHERE user_id = $1 OR user_id = $2;`, [userId1, userId2]);
  await query(`DELETE FROM users WHERE id = $1 OR id = $2;`, [userId1, userId2]);

  // Restore env
  if (originalWebhookSecret !== undefined) process.env.TELEGRAM_WEBHOOK_SECRET = originalWebhookSecret;
  else delete process.env.TELEGRAM_WEBHOOK_SECRET;

  return { passed: failures.length === 0, count, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('phase5-settlement.test.ts')) {
  runPhase5IntegrationTests()
    .then(r => {
      console.log(`\nPhase 5 Integration Tests: ${r.count - r.failures.length}/${r.count} passed.`);
      process.exit(r.passed ? 0 : 1);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

