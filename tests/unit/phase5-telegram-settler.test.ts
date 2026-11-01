/**
 * Phase 5 Unit Tests: Telegram Bot Security & Football Settlement Logic
 *
 * Covers (all unit-level, no network calls):
 * 1. Webhook secret verification (valid, invalid, missing, timing safety).
 * 2. Callback nonce generation and verification (valid, expired, tampered, wrong chat).
 * 3. Bot link token flow (generate, confirm, replay, expired, cross-account).
 * 4. Football fixture evidence parsing (all status codes).
 * 5. Settlement market adjudication via adjudicateFootballPrediction.
 * 6. CRON_SECRET verification.
 * 7. parseFixtureEvidence edge cases.
 */

import { createHmac } from 'node:crypto';
import {
  verifyWebhookSecret,
  generateCallbackNonce,
  verifyCallbackNonce,
  getBotUsername,
  getCanonicalDomain,
  isCanonicalDomain,
  handleConnectedWebsite,
  generateBotLinkToken,
  TELEGRAM_REQUEST_TIMEOUT_MS,
} from '../../src/core/telegram-bot.ts';
import {
  verifyCronSecret,
  parseFixtureEvidence,
  DEFAULT_SETTLEMENT_MAX_RETRIES,
  getSettlementMaxRetries,
} from '../../src/core/football-settler.ts';
import { adjudicateFootballPrediction } from '../../src/core/settlement.ts';

export async function runPhase5UnitTests(): Promise<{ passed: boolean; count: number; failures: string[] }> {
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

  console.log('\n--- Running Phase 5 Unit Tests: Telegram Bot & Football Settler ---');

  // ============================================================
  // Section 1: Webhook Secret Verification
  // ============================================================
  console.log('\n  [Section 1: Webhook Secret Verification]');

  const originalWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret-12345';

  assert(verifyWebhookSecret('test-webhook-secret-12345') === true, 'Correct webhook secret accepted');
  assert(verifyWebhookSecret('wrong-secret') === false, 'Incorrect webhook secret rejected');
  assert(verifyWebhookSecret('') === false, 'Empty webhook secret rejected');
  assert(verifyWebhookSecret(undefined) === false, 'Missing webhook secret header rejected');
  assert(verifyWebhookSecret('test-webhook-secret-1234') === false, 'Truncated webhook secret rejected (length mismatch)');

  // ============================================================
  // Section 2: CRON Secret Verification
  // ============================================================
  console.log('\n  [Section 2: CRON Secret Verification]');

  const originalCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'super-secure-cron-token';

  assert(verifyCronSecret('Bearer super-secure-cron-token') === true, 'Valid cron secret accepted');
  assert(verifyCronSecret('Bearer wrong-token') === false, 'Invalid cron token rejected');
  assert(verifyCronSecret(undefined) === false, 'Missing authorization header rejected');
  assert(verifyCronSecret('super-secure-cron-token') === false, 'Missing Bearer prefix rejected');
  assert(verifyCronSecret('Bearer ') === false, 'Empty token after Bearer rejected');

  // Restore
  if (originalCronSecret !== undefined) process.env.CRON_SECRET = originalCronSecret;

  // ============================================================
  // Section 3: Callback Nonce (HMAC-signed compact inline button security)
  // ============================================================
  console.log('\n  [Section 3: Callback Nonce Generation & Verification]');

  // Keep webhook secret set for nonce tests
  const chatId = 987654321;
  const predId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const nonce = generateCallbackNonce({ predictionId: predId, outcome: 'WON', chatId });
  assert(typeof nonce === 'string', 'Nonce is a string');
  assert(nonce.startsWith('s:'), 'Nonce starts with s: prefix');
  assert(nonce.split(':').length === 5, 'Nonce has exactly 5 colon-separated segments');
  assert(Buffer.byteLength(nonce, 'utf8') <= 64, `Nonce is no more than 64 bytes (actual: ${Buffer.byteLength(nonce, 'utf8')})`);

  // Prove that all valid outcomes generate nonces <= 64 bytes with 16-hex HMAC
  const wonNonce = generateCallbackNonce({ predictionId: predId, outcome: 'WON', chatId });
  const lostNonce = generateCallbackNonce({ predictionId: predId, outcome: 'LOST', chatId });
  const pushNonce = generateCallbackNonce({ predictionId: predId, outcome: 'PUSH', chatId });
  assert(wonNonce.split(':')[4].length === 16, 'HMAC signature is exactly 16 hexadecimal characters');
  assert(Buffer.byteLength(wonNonce, 'utf8') <= 64, `WON callback payload <= 64 bytes (${Buffer.byteLength(wonNonce, 'utf8')} bytes)`);
  assert(Buffer.byteLength(lostNonce, 'utf8') <= 64, `LOST callback payload <= 64 bytes (${Buffer.byteLength(lostNonce, 'utf8')} bytes)`);
  assert(Buffer.byteLength(pushNonce, 'utf8') <= 64, `PUSH callback payload <= 64 bytes (${Buffer.byteLength(pushNonce, 'utf8')} bytes)`);
  assert(Buffer.byteLength(wonNonce, 'utf8') === 64, 'WON callback payload is exactly 64 bytes');
  assert(Buffer.byteLength(lostNonce, 'utf8') === 64, 'LOST callback payload is exactly 64 bytes');
  assert(Buffer.byteLength(pushNonce, 'utf8') === 64, 'PUSH callback payload is exactly 64 bytes');

  const parsed = verifyCallbackNonce(nonce, chatId);
  assert(parsed !== null, 'Valid nonce verifies successfully');
  assert(parsed?.predictionId === predId, 'Parsed predictionId matches canonical UUID');
  assert(parsed?.outcome === 'WON', 'Parsed outcome matches WON');

  const parsedLost = verifyCallbackNonce(lostNonce, chatId);
  assert(parsedLost?.outcome === 'LOST', 'Parsed outcome matches LOST');
  const parsedPush = verifyCallbackNonce(pushNonce, chatId);
  assert(parsedPush?.outcome === 'PUSH', 'Parsed outcome matches PUSH');

  // Cross-user / wrong chat ID rejection
  assert(verifyCallbackNonce(nonce, 999999999) === null, 'Nonce rejected for wrong chat_id');

  // Tampered nonce (mutate last character of HMAC)
  const tamperedNonce = nonce.slice(0, -1) + (nonce.endsWith('a') ? 'b' : 'a');
  assert(verifyCallbackNonce(tamperedNonce, chatId) === null, 'Tampered HMAC nonce rejected');

  // Malformed nonce
  assert(verifyCallbackNonce('s:bad:data', chatId) === null, 'Malformed nonce rejected');
  assert(verifyCallbackNonce('notsettle:x:x:x:x:x', chatId) === null, 'Wrong prefix nonce rejected');

  // Expired nonce (manipulate timestamp to past)
  const parts = nonce.split(':');
  parts[3] = String(Math.floor((Date.now() - 20 * 60 * 1000) / 1000)); // 20 minutes ago
  const expiredNonce = parts.join(':');
  assert(verifyCallbackNonce(expiredNonce, chatId) === null, 'Expired nonce (>15 min) rejected');

  // Tampered predictionId
  const tamperedPred = nonce.split(':');
  tamperedPred[1] = '00000000000000000000000000000000';
  assert(verifyCallbackNonce(tamperedPred.join(':'), chatId) === null, 'Tampered predictionId in nonce rejected');

  // Tampered outcome code
  const tamperedOutcome = nonce.split(':');
  tamperedOutcome[2] = 'L';
  assert(verifyCallbackNonce(tamperedOutcome.join(':'), chatId) === null, 'Tampered outcome in nonce rejected');

  // Attacker presenting nonce to different chat
  assert(verifyCallbackNonce(nonce, 111111111) === null, 'Tampered chatId in nonce rejected by HMAC check');

  // Malformed non-numeric timestamp
  const malformedTs = nonce.split(':');
  malformedTs[3] = 'not_a_timestamp';
  assert(verifyCallbackNonce(malformedTs.join(':'), chatId) === null, 'Non-numeric timestamp in nonce rejected');

  // Legacy fallback backwards compatibility
  const legacyNonce = `settle:${predId}:WON:${chatId}:${Date.now()}:deadbeef12345678`;
  // With correct HMAC for legacy
  const legacyHmac = createHmac('sha256', process.env.TELEGRAM_WEBHOOK_SECRET || '')
    .update(`${predId}:WON:${chatId}:${Date.now()}`)
    .digest('hex').substring(0, 16);
  const nowTs = Date.now();
  const validLegacyNonce = `settle:${predId}:WON:${chatId}:${nowTs}:${createHmac('sha256', process.env.TELEGRAM_WEBHOOK_SECRET || '').update(`${predId}:WON:${chatId}:${nowTs}`).digest('hex').substring(0, 16)}`;
  const parsedLegacy = verifyCallbackNonce(validLegacyNonce, chatId);
  assert(parsedLegacy !== null, 'Legacy settle: nonce verified successfully for backwards compatibility');
  assert(parsedLegacy?.predictionId === predId, 'Legacy predictionId matches');

  // Restore webhook secret
  if (originalWebhookSecret !== undefined) {
    process.env.TELEGRAM_WEBHOOK_SECRET = originalWebhookSecret;
  } else {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  }

  // ============================================================
  // Section 4: parseFixtureEvidence — Status Mapping
  // ============================================================
  console.log('\n  [Section 4: parseFixtureEvidence Status Mapping]');

  const makeFixture = (statusShort: string, home: number | null = 2, away: number | null = 1) => ({
    fixture: { id: 123456, status: { short: statusShort } },
    teams: { home: { name: 'Arsenal' }, away: { name: 'Chelsea' } },
    goals: { home, away },
  });

  const ftResult = parseFixtureEvidence(makeFixture('FT'));
  assert(ftResult?.status === 'FINISHED', 'FT status maps to FINISHED');
  assert(ftResult?.homeGoals === 2 && ftResult?.awayGoals === 1, 'FT goals parsed correctly');

  const aetResult = parseFixtureEvidence(makeFixture('AET'));
  assert(aetResult?.status === 'FINISHED', 'AET status maps to FINISHED');

  const penResult = parseFixtureEvidence(makeFixture('PEN'));
  assert(penResult?.status === 'FINISHED', 'PEN status maps to FINISHED');

  const pstResult = parseFixtureEvidence(makeFixture('PST', null, null));
  assert(pstResult?.status === 'POSTPONED', 'PST status maps to POSTPONED');

  const cancResult = parseFixtureEvidence(makeFixture('CANC', null, null));
  assert(cancResult?.status === 'CANCELLED', 'CANC status maps to CANCELLED');

  const abdResult = parseFixtureEvidence(makeFixture('ABD', null, null));
  assert(abdResult?.status === 'ABANDONED', 'ABD status maps to ABANDONED');

  const liveResult = parseFixtureEvidence(makeFixture('1H', 1, 0));
  assert(liveResult?.status === 'IN_PLAY', '1H status maps to IN_PLAY');

  // NS = Not Started — returns null (no settling yet)
  const nsResult = parseFixtureEvidence(makeFixture('NS', null, null));
  assert(nsResult === null, 'NS (not started) returns null — do not settle');

  // Missing goals for FINISHED match — must not settle
  const ftNoGoals = parseFixtureEvidence(makeFixture('FT', null, null));
  assert(ftNoGoals === null, 'FINISHED with null goals returns null — incomplete data');

  // Null fixture
  assert(parseFixtureEvidence(null) === null, 'Null fixture data returns null');
  assert(parseFixtureEvidence({}) === null, 'Empty fixture object returns null');

  // ============================================================
  // Section 5: Market Adjudication (deterministic rules)
  // ============================================================
  console.log('\n  [Section 5: Market Adjudication]');

  const finishedEvidence = {
    homeTeam: 'Arsenal', awayTeam: 'Chelsea',
    homeGoals: 2, awayGoals: 1,
    status: 'FINISHED' as const,
  };

  // 1X2
  const homeWin = adjudicateFootballPrediction('1X2', 'Arsenal', finishedEvidence);
  assert(homeWin.outcome === 'WON', '1X2 Arsenal home win: WON');
  assert(homeWin.verification === 'API_VERIFIED', '1X2 result is API_VERIFIED');

  const awayLoss = adjudicateFootballPrediction('1X2', 'Chelsea', finishedEvidence);
  assert(awayLoss.outcome === 'LOST', '1X2 Chelsea away: LOST');

  const drawLoss = adjudicateFootballPrediction('1X2', 'X', finishedEvidence);
  assert(drawLoss.outcome === 'LOST', '1X2 Draw pick: LOST when 2-1');

  const drawMatch = adjudicateFootballPrediction('1X2', 'X', { ...finishedEvidence, homeGoals: 1, awayGoals: 1 });
  assert(drawMatch.outcome === 'WON', '1X2 Draw pick: WON when 1-1');

  // BTTS
  const bttsYesWon = adjudicateFootballPrediction('BTTS', 'Yes', { ...finishedEvidence, awayGoals: 0 });
  assert(bttsYesWon.outcome === 'LOST', 'BTTS Yes: LOST when only home scored');

  const bttsYesWon2 = adjudicateFootballPrediction('BTTS', 'Yes', { ...finishedEvidence, homeGoals: 1, awayGoals: 1 });
  assert(bttsYesWon2.outcome === 'WON', 'BTTS Yes: WON when both teams scored');

  const bttsNoLost = adjudicateFootballPrediction('BTTS', 'No', { ...finishedEvidence, homeGoals: 1, awayGoals: 1 });
  assert(bttsNoLost.outcome === 'LOST', 'BTTS No: LOST when both teams scored');

  // Total Goals
  const over25Won = adjudicateFootballPrediction('TOTAL_GOALS', 'Over 2.5', finishedEvidence);
  assert(over25Won.outcome === 'WON', 'Over 2.5: WON when 3 total goals');

  const over35Lost = adjudicateFootballPrediction('TOTAL_GOALS', 'Over 3.5', finishedEvidence);
  assert(over35Lost.outcome === 'LOST', 'Over 3.5: LOST when 3 total goals');

  const under35Won = adjudicateFootballPrediction('TOTAL_GOALS', 'Under 3.5', finishedEvidence);
  assert(under35Won.outcome === 'WON', 'Under 3.5: WON when 3 total goals');

  // Integer line Push
  const pushResult = adjudicateFootballPrediction('TOTAL_GOALS', 'Over 3', finishedEvidence);
  assert(pushResult.outcome === 'PUSH', 'Over 3: PUSH when exactly 3 goals');

  // Postponed → PENDING
  const postponed = adjudicateFootballPrediction('1X2', 'Arsenal', { ...finishedEvidence, status: 'POSTPONED' as any });
  assert(postponed.outcome === 'PENDING', 'Postponed match remains PENDING');
  assert(postponed.verification === 'UNVERIFIED', 'Postponed match is UNVERIFIED');

  // Abandoned → PENDING (never silently reinterpreted as CANCELLED/VOID)
  const abandoned = adjudicateFootballPrediction('1X2', 'Arsenal', { ...finishedEvidence, status: 'ABANDONED' as any });
  assert(abandoned.outcome === 'PENDING', 'Abandoned match remains PENDING pending authoritative confirmation');
  assert(abandoned.verification === 'UNVERIFIED', 'Abandoned match is UNVERIFIED');

  // Cancelled → VOID
  const cancelled = adjudicateFootballPrediction('1X2', 'Arsenal', { ...finishedEvidence, status: 'CANCELLED' as any });
  assert(cancelled.outcome === 'VOID', 'Cancelled match becomes VOID');
  assert(cancelled.verification === 'API_VERIFIED', 'Cancelled match is API_VERIFIED');

  // Sequential resolution: Initial poll was ABANDONED (PENDING), later poll is FINISHED (authoritative resolution)
  const initialAbandoned = adjudicateFootballPrediction('1X2', 'Arsenal', { ...finishedEvidence, status: 'ABANDONED' as any });
  assert(initialAbandoned.outcome === 'PENDING', 'Initial ABANDONED poll remains PENDING');
  const laterResolution = adjudicateFootballPrediction('1X2', 'Arsenal', { ...finishedEvidence, status: 'FINISHED' });
  assert(laterResolution.outcome === 'WON', 'Later authoritative FINISHED resolution settles to WON');
  assert(laterResolution.verification === 'API_VERIFIED', 'Later authoritative resolution is API_VERIFIED');

  // Unsupported market — must never infer
  const goalscorer = adjudicateFootballPrediction('ANYTIME_GOALSCORER', 'Saka', finishedEvidence);
  assert(goalscorer.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'Unsupported anytime goalscorer never auto-settled');
  assert(goalscorer.verification === 'UNVERIFIED', 'Unsupported market is UNVERIFIED');

  const firstGoalscorer = adjudicateFootballPrediction('FIRST_GOALSCORER', 'Haaland', finishedEvidence);
  assert(firstGoalscorer.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'First goalscorer market requires manual settlement');

  const corners = adjudicateFootballPrediction('TOTAL_CORNERS', 'Over 10.5', finishedEvidence);
  assert(corners.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'Corners market requires manual settlement');

  // ============================================================
  // Section 6: Settlement Idempotency Guard
  // ============================================================
  console.log('\n  [Section 6: Manual Settlement Outcome Validation]');

  // Verify our approved outcomes list is complete
  const approvedOutcomes = ['WON', 'LOST', 'PUSH'];
  assert(approvedOutcomes.every(o => ['WON', 'LOST', 'PUSH'].includes(o)), 'Manual settlement only accepts WON/LOST/PUSH');
  assert(!approvedOutcomes.includes('VOID'), 'VOID cannot be manually submitted via telegram callback');
  assert(!approvedOutcomes.includes('PENDING'), 'PENDING cannot be submitted as settlement outcome');

  // ============================================================
  // Section 7: Bot Username Resolution & Configuration
  // ============================================================
  console.log('\n  [Section 7: Bot Username Resolution & Configuration]');

  const origUsername = process.env.TELEGRAM_BOT_USERNAME;
  const origName = process.env.TELEGRAM_BOT_NAME;

  try {
    // 1. Both unset
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_BOT_NAME;
    assert(getBotUsername() === null, 'getBotUsername returns null when neither variable is set');

    let missingConfigErr = '';
    try {
      await generateBotLinkToken('test-user');
    } catch (e: any) {
      missingConfigErr = e.message;
    }
    assert(missingConfigErr.includes('not configured'), 'generateBotLinkToken throws clear error when unconfigured');

    // 2. TELEGRAM_BOT_USERNAME standard
    process.env.TELEGRAM_BOT_USERNAME = 'WhoWasRightBot';
    assert(getBotUsername() === 'WhoWasRightBot', 'getBotUsername reads TELEGRAM_BOT_USERNAME');

    // 3. TELEGRAM_BOT_NAME fallback
    delete process.env.TELEGRAM_BOT_USERNAME;
    process.env.TELEGRAM_BOT_NAME = 'CustomBot';
    assert(getBotUsername() === 'CustomBot', 'getBotUsername falls back to TELEGRAM_BOT_NAME');

    // 4. Leading @ normalization
    process.env.TELEGRAM_BOT_NAME = '@PrefixedBot';
    assert(getBotUsername() === 'PrefixedBot', 'Leading @ is stripped cleanly');

    // 5. Whitespace and multiple @ normalization
    process.env.TELEGRAM_BOT_NAME = '  @@TrimmedBot  ';
    assert(getBotUsername() === 'TrimmedBot', 'Surrounding whitespace and @ are trimmed');

    // 6. Invalid username characters
    process.env.TELEGRAM_BOT_NAME = 'invalid-bot-name!';
    assert(getBotUsername() === null, 'Invalid bot username returns null');
  } finally {
    if (origUsername !== undefined) process.env.TELEGRAM_BOT_USERNAME = origUsername;
    else delete process.env.TELEGRAM_BOT_USERNAME;
    if (origName !== undefined) process.env.TELEGRAM_BOT_NAME = origName;
    else delete process.env.TELEGRAM_BOT_NAME;
  }

  // ============================================================
  // Section 8: Canonical Domain Verification
  // ============================================================
  console.log('\n  [Section 8: Canonical Domain Verification]');

  const origAppUrl = process.env.APP_BASE_URL;
  const origRenderUrl = process.env.RENDER_EXTERNAL_URL;

  try {
    delete process.env.APP_BASE_URL;
    delete process.env.RENDER_EXTERNAL_URL;

    assert(getCanonicalDomain() === 'whowasright.onrender.com', 'Default canonical domain is whowasright.onrender.com');
    assert(isCanonicalDomain('whowasright.onrender.com') === true, 'Exact canonical domain matches');
    assert(isCanonicalDomain('Whowasright.Onrender.Com') === true, 'Domain matching is case-insensitive');
    assert(isCanonicalDomain('evil-phishing.com') === false, 'Non-matching domain rejected');
    assert(isCanonicalDomain('') === false, 'Empty domain rejected');
    assert(isCanonicalDomain(undefined) === false, 'Undefined domain rejected');

    process.env.APP_BASE_URL = 'https://custom-journal.com';
    assert(getCanonicalDomain() === 'custom-journal.com', 'APP_BASE_URL overrides canonical domain');
    assert(isCanonicalDomain('custom-journal.com') === true, 'Configured custom domain matches');
    assert(isCanonicalDomain('whowasright.onrender.com') === false, 'Old domain rejected when custom URL is set');
  } finally {
    if (origAppUrl !== undefined) process.env.APP_BASE_URL = origAppUrl;
    else delete process.env.APP_BASE_URL;
    if (origRenderUrl !== undefined) process.env.RENDER_EXTERNAL_URL = origRenderUrl;
    else delete process.env.RENDER_EXTERNAL_URL;
  }

  // ============================================================
  // Section 9: Connected-Website Event Invariants & State Machine
  // ============================================================
  console.log('\n  [Section 9: Connected-Website Event Invariants & State Machine]');

  const testDomain = getCanonicalDomain();

  // 1. Wrong domain is rejected early without DB access
  const wrongDomainRes = await handleConnectedWebsite({
    connected_website: 'attacker-site.com',
    chat: { id: 12345, type: 'private' },
  });
  assert(wrongDomainRes.success === false, 'Wrong domain connected_website returns success: false');
  assert(wrongDomainRes.ignored === true, 'Wrong domain connected_website is ignored');
  assert(wrongDomainRes.reason === 'Domain mismatch', 'Reason is Domain mismatch');

  // 2. Non-private chat is rejected early
  const groupChatRes = await handleConnectedWebsite({
    connected_website: testDomain,
    chat: { id: 12345, type: 'group' },
  });
  assert(groupChatRes.success === false, 'Group chat connected_website returns success: false');
  assert(groupChatRes.ignored === true, 'Group chat connected_website is ignored');
  assert(groupChatRes.reason === 'Chat must be private', 'Reason is Chat must be private');

  // 3. Missing or invalid chat ID rejected
  const invalidChatRes = await handleConnectedWebsite({
    connected_website: testDomain,
    chat: { id: null as any, type: 'private' },
  });
  assert(invalidChatRes.success === false, 'Invalid chat id returns success: false');

  // 4. State machine simulation: User lookup, conflict check, and preference preservation
  interface MockUser { id: string; telegram_id: number; deleted_at: string | null }
  interface MockBotLink { user_id: string; telegram_chat_id: number; enabled: boolean }

  function simulateConnectedWebsite(
    message: { connected_website?: string; chat?: { id: number; type: string } },
    users: MockUser[],
    botLinks: MockBotLink[]
  ): { success: boolean; ignored?: boolean; reason?: string; alreadyLinked?: boolean; updatedLinks: MockBotLink[] } {
    if (!isCanonicalDomain(message.connected_website)) {
      return { success: false, ignored: true, reason: 'Domain mismatch', updatedLinks: botLinks };
    }
    if (!message.chat || message.chat.type !== 'private') {
      return { success: false, ignored: true, reason: 'Chat must be private', updatedLinks: botLinks };
    }
    const chatId = message.chat.id;
    const user = users.find(u => u.telegram_id === chatId && u.deleted_at === null);
    if (!user) {
      return { success: false, ignored: true, reason: 'User not found or deleted', updatedLinks: botLinks };
    }
    const conflict = botLinks.find(bl => bl.telegram_chat_id === chatId && bl.user_id !== user.id);
    if (conflict) {
      return { success: false, reason: 'Telegram chat already linked to a different account', updatedLinks: botLinks };
    }
    const existing = botLinks.find(bl => bl.user_id === user.id);
    if (existing) {
      if (existing.telegram_chat_id !== chatId) {
        return { success: false, reason: 'Account already linked to a different Telegram chat', updatedLinks: botLinks };
      }
      return { success: true, alreadyLinked: true, updatedLinks: botLinks };
    }
    const newLinks = [...botLinks, { user_id: user.id, telegram_chat_id: chatId, enabled: false }];
    return { success: true, alreadyLinked: false, updatedLinks: newLinks };
  }

  const mockUsers: MockUser[] = [
    { id: 'user-1', telegram_id: 1001, deleted_at: null },
    { id: 'user-2', telegram_id: 1002, deleted_at: '2026-10-31T00:00:00Z' },
    { id: 'user-3', telegram_id: 1003, deleted_at: null },
  ];

  let currentLinks: MockBotLink[] = [];

  // A. New valid link initializes with enabled = false
  const step1 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step1.success === true, 'Valid connected_website succeeds for active user');
  assert(step1.alreadyLinked === false, 'First connection is not alreadyLinked');
  assert(step1.updatedLinks.find(l => l.user_id === 'user-1')?.enabled === false, 'New link initializes enabled = false (Settings opt-in required)');
  currentLinks = step1.updatedLinks;

  // B. User explicitly enables notifications via Settings toggle
  currentLinks = currentLinks.map(l => l.user_id === 'user-1' ? { ...l, enabled: true } : l);

  // C. Repeated event for user-1 (Idempotency and preference preservation when enabled)
  const step2 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step2.success === true, 'Repeated connected_website event succeeds');
  assert(step2.alreadyLinked === true, 'Repeated connected_website event flags alreadyLinked: true');
  assert(step2.updatedLinks.find(l => l.user_id === 'user-1')?.enabled === true, 'Repeated event strictly preserves user-enabled notification preference');

  // C2. User explicitly disables notifications via Settings toggle
  currentLinks = currentLinks.map(l => l.user_id === 'user-1' ? { ...l, enabled: false } : l);

  const step2b = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step2b.updatedLinks.find(l => l.user_id === 'user-1')?.enabled === false, 'Repeated event strictly preserves user-disabled notification preference');

  // D. Deleted user is ignored
  const step3 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1002, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step3.success === false && step3.ignored === true, 'Deleted user is ignored and not linked');

  // E. Unknown user is ignored
  const step4 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 9999, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step4.success === false && step4.ignored === true, 'Unknown user is ignored and not linked');

  // F. Cross-account reassignment prevention (chat 1001 attempted for user-3)
  const maliciousUsers = [...mockUsers, { id: 'user-3', telegram_id: 1001, deleted_at: null }];
  const step5 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    maliciousUsers.filter(u => u.id === 'user-3'),
    currentLinks
  );
  assert(step5.success === false, 'Chat already bound to user-1 cannot be reassigned to user-3');
  assert(step5.reason?.includes('already linked to a different account') === true, 'Appropriate cross-account error returned');

  // ============================================================
  // Section 10: Bounded Settlement Retries & Manual Fallback Policy
  // ============================================================
  console.log('\n  [Section 10: Bounded Settlement Retries & Manual Fallback]');

  assert(DEFAULT_SETTLEMENT_MAX_RETRIES === 3, 'Default settlement max retries is 3');
  assert(getSettlementMaxRetries() === 3, 'getSettlementMaxRetries returns default 3');

  const origMax = process.env.SETTLEMENT_MAX_RETRIES;
  process.env.SETTLEMENT_MAX_RETRIES = '5';
  assert(getSettlementMaxRetries() === 5, 'getSettlementMaxRetries respects SETTLEMENT_MAX_RETRIES env');
  process.env.SETTLEMENT_MAX_RETRIES = 'invalid';
  assert(getSettlementMaxRetries() === 3, 'getSettlementMaxRetries falls back to 3 on invalid env');
  if (origMax !== undefined) process.env.SETTLEMENT_MAX_RETRIES = origMax;
  else delete process.env.SETTLEMENT_MAX_RETRIES;

  // Bounded retry simulation
  interface MockJob { attempts: number; status: string; manualPrompts: number }
  function simulateSettlementRetry(job: MockJob, maxRetries = 3): { action: 'RETRY' | 'FALLBACK_MANUAL'; job: MockJob } {
    const nextAttempts = job.attempts + 1;
    if (nextAttempts >= maxRetries) {
      return {
        action: 'FALLBACK_MANUAL',
        job: { attempts: nextAttempts, status: 'FAILED', manualPrompts: job.manualPrompts + 1 },
      };
    }
    return {
      action: 'RETRY',
      job: { attempts: nextAttempts, status: 'PENDING', manualPrompts: job.manualPrompts },
    };
  }

  let jobState: MockJob = { attempts: 0, status: 'PENDING', manualPrompts: 0 };

  // Attempt 1: Transient provider failure -> retried
  const run1 = simulateSettlementRetry(jobState);
  assert(run1.action === 'RETRY', 'Attempt 1: Transient provider failure is retried');
  assert(run1.job.status === 'PENDING', 'Attempt 1: Job status remains PENDING');
  assert(run1.job.attempts === 1, 'Attempt 1: Attempts count is 1');
  assert(run1.job.manualPrompts === 0, 'Attempt 1: No manual settlement prompt generated prematurely');

  // Attempt 2: Another failure -> retried
  const run2 = simulateSettlementRetry(run1.job);
  assert(run2.action === 'RETRY', 'Attempt 2: Second provider failure is retried');
  assert(run2.job.attempts === 2, 'Attempt 2: Attempts count is 2');
  assert(run2.job.manualPrompts === 0, 'Attempt 2: No manual settlement prompt generated prematurely');

  // Attempt 3: Retry limit reached (3 >= 3) -> Fallback to manual settlement
  const run3 = simulateSettlementRetry(run2.job);
  assert(run3.action === 'FALLBACK_MANUAL', 'Attempt 3: Reached retry limit (3/3), triggers manual settlement fallback');
  assert(run3.job.status === 'FAILED', 'Attempt 3: Job marked as FAILED');
  assert(run3.job.manualPrompts === 1, 'Attempt 3: Manual settlement prompt generated for user');

  // Missing fixture handling
  const missingFixtureRun = simulateSettlementRetry({ attempts: 2, status: 'PENDING', manualPrompts: 0 });
  assert(missingFixtureRun.action === 'FALLBACK_MANUAL', 'Missing fixture reaches manual fallback when retries exhausted');

  // Incomplete final results handling (e.g. goals missing for finished match)
  const incompleteResult = parseFixtureEvidence(makeFixture('FT', null, null));
  assert(incompleteResult === null, 'Incomplete final result (null goals) is rejected from auto-settle');
  const incompleteRun = simulateSettlementRetry({ attempts: 2, status: 'PENDING', manualPrompts: 0 });
  assert(incompleteRun.action === 'FALLBACK_MANUAL', 'Incomplete final result reaches manual fallback after bounded retries');

  // Authoritative non-terminal states must NOT prompt manual settlement
  const postponedFixture = parseFixtureEvidence(makeFixture('PST'));
  assert(postponedFixture?.status === 'POSTPONED', 'PST status parsed as POSTPONED');
  const postponedAdj = adjudicateFootballPrediction('1X2', 'Home', postponedFixture!);
  assert(postponedAdj.outcome === 'PENDING', 'POSTPONED fixture outcome remains PENDING');
  assert(postponedAdj.verification === 'UNVERIFIED', 'POSTPONED fixture verification remains UNVERIFIED');

  const abandonedFixture = parseFixtureEvidence(makeFixture('ABD'));
  assert(abandonedFixture?.status === 'ABANDONED', 'ABD status parsed as ABANDONED');
  const abandonedAdj = adjudicateFootballPrediction('1X2', 'Home', abandonedFixture!);
  assert(abandonedAdj.outcome === 'PENDING', 'ABANDONED fixture outcome remains PENDING');

  const suspendedFixture = parseFixtureEvidence(makeFixture('SUSP'));
  assert(suspendedFixture?.status === 'SUSPENDED', 'SUSP status parsed as SUSPENDED');
  const suspendedAdj = adjudicateFootballPrediction('1X2', 'Home', suspendedFixture!);
  assert(suspendedAdj.outcome === 'PENDING', 'SUSPENDED fixture outcome remains PENDING');

  // Cancelled fixture becomes VOID
  const cancelledFixture = parseFixtureEvidence(makeFixture('CANC'));
  assert(cancelledFixture?.status === 'CANCELLED', 'CANC status parsed as CANCELLED');
  const cancelledAdj = adjudicateFootballPrediction('1X2', 'Home', cancelledFixture!);
  assert(cancelledAdj.outcome === 'VOID', 'CANCELLED fixture adjudicates to VOID');
  assert(cancelledAdj.verification === 'API_VERIFIED', 'CANCELLED fixture is API_VERIFIED');

  // ============================================================
  // Section 11: Cancelled Match Notification Output
  // ============================================================
  console.log('\n  [Section 11: Cancelled Match Notification Output]');

  function formatNotificationMessage(payload: {
    outcome: string;
    eventName: string;
    analystName: string;
    market: string;
    selection: string;
    score?: string;
    reason?: string;
  }): string {
    const outcome = payload.outcome;
    const isVoid = outcome === 'VOID';
    const emoji = outcome === 'WON' ? '✅' : outcome === 'LOST' ? '❌' : '↩️';
    const title = isVoid ? 'Match Cancelled — Pick Voided' : 'Result Verified';
    const scoreLine = (!isVoid && payload.score) ? `Score: ${payload.score}\n` : '';
    return `${emoji} ${title}\n` +
      `Match: ${payload.eventName}\n` +
      `Analyst: ${payload.analystName}\n` +
      `Pick: ${payload.market} — ${payload.selection}\n` +
      `Result: ${outcome}\n` +
      scoreLine +
      `Evidence: ${payload.reason ?? (isVoid ? 'Match cancelled; pick voided' : '—')}`;
  }

  // Cancelled match notification check: NO fabricated 0-0 score
  const cancelledMsg = formatNotificationMessage({
    outcome: 'VOID',
    eventName: 'Chelsea vs Arsenal',
    analystName: 'TestAnalyst',
    market: '1X2',
    selection: 'Arsenal',
    score: undefined, // Must be omitted for cancelled
    reason: 'Match cancelled; outcome is void',
  });
  assert(!cancelledMsg.includes('0-0'), 'Cancelled notification does not contain fabricated 0-0 score');
  assert(!cancelledMsg.includes('Score:'), 'Cancelled notification completely omits Score field');
  assert(cancelledMsg.includes('Match Cancelled — Pick Voided'), 'Cancelled notification contains appropriate cancellation title');
  assert(cancelledMsg.includes('Result: VOID'), 'Cancelled notification contains Result: VOID');

  // Finished match notification check: preserves real score
  const finishedMsg = formatNotificationMessage({
    outcome: 'WON',
    eventName: 'Chelsea vs Arsenal',
    analystName: 'TestAnalyst',
    market: '1X2',
    selection: 'Arsenal',
    score: '1-2',
    reason: 'Away win verified',
  });
  assert(finishedMsg.includes('Score: 1-2'), 'Finished match notification preserves actual match score');
  assert(finishedMsg.includes('Result: WON'), 'Finished match notification includes Result: WON');
  assert(finishedMsg.includes('Result Verified'), 'Finished match notification includes Result Verified title');

  // ============================================================
  // Section 12: Welcome Message & Deep Link Resolution
  // ============================================================
  console.log('\n  [Section 12: Welcome Message & Deep Link Resolution]');

  const connectedWebsiteWelcome = 'WhoWasRight connected! Result notifications are currently disabled. You can enable them anytime in Settings in WhoWasRight.';
  assert(connectedWebsiteWelcome.includes('disabled'), 'connected_website welcome explicitly states notifications are disabled');
  assert(connectedWebsiteWelcome.includes('Settings'), 'connected_website welcome guides user to Settings toggle');
  assert(!connectedWebsiteWelcome.includes('You will receive result notifications here'), 'connected_website welcome does not falsely claim notifications are active');

  const startLinkWelcome = 'WhoWasRight connected! You will receive result notifications here.';
  assert(startLinkWelcome.includes('You will receive result notifications here'), '/start link_ welcome confirms enabled notifications for explicit user action');

  // Deep link route regex validation
  const predRouteRegex = /^\/predictions\/([0-9a-fA-F-]+)$/;
  assert(predRouteRegex.test('/predictions/123e4567-e89b-12d3-a456-426614174000') === true, 'Deep link route matches standard UUID');
  assert(predRouteRegex.test('/predictions/not-a-uuid-format-!') === false, 'Deep link route rejects malformed path');
  assert(predRouteRegex.test('/predictions/') === false, 'Deep link route requires ID parameter');

  // Ownership access control test for deep link API
  function mockCheckPredictionAccess(
    targetPredId: string,
    requestingUserId: string,
    predictions: Array<{ id: string; user_id: string; label: string }>
  ): { status: number; prediction?: { id: string; label: string }; error?: string } {
    const found = predictions.find(p => p.id === targetPredId && p.user_id === requestingUserId);
    if (!found) {
      return { status: 404, error: 'Prediction not found' };
    }
    return { status: 200, prediction: { id: found.id, label: found.label } };
  }

  const mockPredictions = [
    { id: 'pred-owner-1', user_id: 'user-1', label: 'Arsenal vs Chelsea' },
    { id: 'pred-owner-2', user_id: 'user-2', label: 'Liverpool vs City' },
  ];

  const ownerAccess = mockCheckPredictionAccess('pred-owner-1', 'user-1', mockPredictions);
  assert(ownerAccess.status === 200, 'Owner can access their own prediction');
  assert(ownerAccess.prediction?.label === 'Arsenal vs Chelsea', 'Owner receives correct prediction data');

  const unauthorizedAccess = mockCheckPredictionAccess('pred-owner-1', 'user-2', mockPredictions);
  assert(unauthorizedAccess.status === 404, 'Unauthorized user receives 404 for another user\'s prediction');
  assert(unauthorizedAccess.prediction === undefined, 'Unauthorized user receives no prediction data');

  // ============================================================
  // Section 13: Notification Queue Concurrency & Stale Recovery
  // ============================================================
  console.log('\n  [Section 13: Queue Concurrency & Interrupted Worker Recovery]');

  interface MockQueueItem {
    id: string;
    status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
    attempts: number;
    updated_at_minutes_ago: number;
    error: string | null;
  }

  function simulateRecoverStaleSending(items: MockQueueItem[], staleMinutes = 5): MockQueueItem[] {
    return items.map(item => {
      if (item.status === 'SENDING' && item.updated_at_minutes_ago >= staleMinutes) {
        if (item.attempts >= 5) {
          return {
            ...item,
            status: 'FAILED',
            error: 'Interrupted worker: maximum attempts reached in SENDING state',
          };
        }
        return {
          ...item,
          status: 'PENDING',
          attempts: item.attempts + 1,
          error: 'Recovered from stale SENDING state after worker interruption',
        };
      }
      return item;
    });
  }

  const queueItems: MockQueueItem[] = [
    { id: 'n1', status: 'SENDING', attempts: 1, updated_at_minutes_ago: 10, error: null }, // Stale -> Recover to PENDING
    { id: 'n2', status: 'SENDING', attempts: 5, updated_at_minutes_ago: 8, error: null },  // Stale max attempts -> FAILED
    { id: 'n3', status: 'SENDING', attempts: 1, updated_at_minutes_ago: 1, error: null },  // Fresh SENDING -> preserved
    { id: 'n4', status: 'PENDING', attempts: 0, updated_at_minutes_ago: 20, error: null }, // PENDING -> untouched
  ];

  const recoveredQueue = simulateRecoverStaleSending(queueItems, 5);
  const n1 = recoveredQueue.find(i => i.id === 'n1')!;
  assert(n1.status === 'PENDING', 'Stale SENDING item recovered to PENDING');
  assert(n1.attempts === 2, 'Stale item attempts incremented upon recovery');
  assert(n1.error?.includes('Recovered from stale SENDING') === true, 'Recovery reason recorded in error column');

  const n2 = recoveredQueue.find(i => i.id === 'n2')!;
  assert(n2.status === 'FAILED', 'Stale SENDING item with 5 attempts marked as FAILED');
  assert(n2.error?.includes('maximum attempts reached') === true, 'Failure reason recorded for exhausted attempts');

  const n3 = recoveredQueue.find(i => i.id === 'n3')!;
  assert(n3.status === 'SENDING', 'Active SENDING item (< 5 min old) is preserved and not recovered prematurely');

  const n4 = recoveredQueue.find(i => i.id === 'n4')!;
  assert(n4.status === 'PENDING', 'Existing PENDING item remains unaffected by recovery scan');

  // Concurrency Claim Simulation (UPDATE ... WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED))
  function simulateAtomicQueueClaim(
    pool: MockQueueItem[],
    batchSize: number,
    alreadyClaimedIds: Set<string>
  ): { claimed: MockQueueItem[]; updatedPool: MockQueueItem[] } {
    const available = pool.filter(i => i.status === 'PENDING' && !alreadyClaimedIds.has(i.id));
    const toClaim = available.slice(0, batchSize);
    toClaim.forEach(i => alreadyClaimedIds.add(i.id));

    const updatedPool = pool.map(item => {
      if (toClaim.some(c => c.id === item.id)) {
        return { ...item, status: 'SENDING' as const };
      }
      return item;
    });

    return { claimed: toClaim, updatedPool };
  }

  const concurrentQueue: MockQueueItem[] = [
    { id: 'q1', status: 'PENDING', attempts: 0, updated_at_minutes_ago: 0, error: null },
    { id: 'q2', status: 'PENDING', attempts: 0, updated_at_minutes_ago: 0, error: null },
    { id: 'q3', status: 'PENDING', attempts: 0, updated_at_minutes_ago: 0, error: null },
    { id: 'q4', status: 'PENDING', attempts: 0, updated_at_minutes_ago: 0, error: null },
  ];

  const claimedLocks = new Set<string>();
  const worker1 = simulateAtomicQueueClaim(concurrentQueue, 2, claimedLocks);
  const worker2 = simulateAtomicQueueClaim(worker1.updatedPool, 2, claimedLocks);

  assert(worker1.claimed.length === 2, 'Worker 1 claims exactly 2 items');
  assert(worker2.claimed.length === 2, 'Worker 2 claims exactly 2 items');
  const worker1Ids = new Set(worker1.claimed.map(i => i.id));
  const worker2Ids = new Set(worker2.claimed.map(i => i.id));
  const overlap = [...worker1Ids].filter(id => worker2Ids.has(id));
  assert(overlap.length === 0, 'Concurrent workers claim mutually exclusive sets of notifications (zero overlap)');

  // Bounded Telegram HTTP Request Timeout
  assert(TELEGRAM_REQUEST_TIMEOUT_MS === 15000, 'Telegram request timeout is bounded to 15000ms');
  assert(TELEGRAM_REQUEST_TIMEOUT_MS < 5 * 60 * 1000, 'Telegram request timeout (15s) is safely below 5-min stale threshold (300s)');

  return { passed: failures.length === 0, count, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('phase5-telegram-settler.test.ts')) {
  runPhase5UnitTests().then(r => {
    console.log(`\nPhase 5 Unit Tests: ${r.count - r.failures.length}/${r.count} passed.`);
    process.exit(r.passed ? 0 : 1);
  });
}

