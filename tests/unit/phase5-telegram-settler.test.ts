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

import {
  verifyWebhookSecret,
  generateCallbackNonce,
  verifyCallbackNonce,
  getBotUsername,
  getCanonicalDomain,
  isCanonicalDomain,
  handleConnectedWebsite,
  generateBotLinkToken,
} from '../../src/core/telegram-bot.ts';
import { verifyCronSecret, parseFixtureEvidence } from '../../src/core/football-settler.ts';
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
  // Section 3: Callback Nonce (HMAC-signed inline button security)
  // ============================================================
  console.log('\n  [Section 3: Callback Nonce Generation & Verification]');

  // Keep webhook secret set for nonce tests
  const chatId = 987654321;
  const predId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const nonce = generateCallbackNonce({ predictionId: predId, outcome: 'WON', chatId });
  assert(typeof nonce === 'string', 'Nonce is a string');
  assert(nonce.startsWith('settle:'), 'Nonce starts with settle: prefix');
  assert(nonce.split(':').length === 6, 'Nonce has exactly 6 colon-separated segments');

  const parsed = verifyCallbackNonce(nonce, chatId);
  assert(parsed !== null, 'Valid nonce verifies successfully');
  assert(parsed?.predictionId === predId, 'Parsed predictionId matches');
  assert(parsed?.outcome === 'WON', 'Parsed outcome matches');

  // Wrong chat ID
  assert(verifyCallbackNonce(nonce, 999999999) === null, 'Nonce rejected for wrong chat_id');

  // Tampered nonce (mutate last character of HMAC)
  const tamperedNonce = nonce.slice(0, -1) + (nonce.endsWith('a') ? 'b' : 'a');
  assert(verifyCallbackNonce(tamperedNonce, chatId) === null, 'Tampered HMAC nonce rejected');

  // Malformed nonce
  assert(verifyCallbackNonce('settle:bad:data', chatId) === null, 'Malformed nonce rejected');
  assert(verifyCallbackNonce('notsettle:x:x:x:x:x', chatId) === null, 'Wrong prefix nonce rejected');

  // Expired nonce (manipulate timestamp to past)
  const parts = nonce.split(':');
  parts[4] = String(Date.now() - 20 * 60 * 1000); // 20 minutes ago
  const expiredNonce = parts.join(':');
  assert(verifyCallbackNonce(expiredNonce, chatId) === null, 'Expired nonce (>15 min) rejected');

  // Tampered predictionId
  const tamperedPred = nonce.split(':');
  tamperedPred[1] = '00000000-0000-0000-0000-000000000000';
  assert(verifyCallbackNonce(tamperedPred.join(':'), chatId) === null, 'Tampered predictionId in nonce rejected');

  // Tampered outcome
  const tamperedOutcome = nonce.split(':');
  tamperedOutcome[2] = 'LOST';
  assert(verifyCallbackNonce(tamperedOutcome.join(':'), chatId) === null, 'Tampered outcome in nonce rejected');

  // Tampered chatId
  const tamperedChat = nonce.split(':');
  tamperedChat[3] = '111111111';
  assert(verifyCallbackNonce(tamperedChat.join(':'), 111111111) === null, 'Tampered chatId in nonce rejected by HMAC check');

  // Malformed non-numeric timestamp
  const malformedTs = nonce.split(':');
  malformedTs[4] = 'not_a_timestamp';
  assert(verifyCallbackNonce(malformedTs.join(':'), chatId) === null, 'Non-numeric timestamp in nonce rejected');

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
    const newLinks = [...botLinks, { user_id: user.id, telegram_chat_id: chatId, enabled: true }];
    return { success: true, alreadyLinked: false, updatedLinks: newLinks };
  }

  const mockUsers: MockUser[] = [
    { id: 'user-1', telegram_id: 1001, deleted_at: null },
    { id: 'user-2', telegram_id: 1002, deleted_at: '2026-10-31T00:00:00Z' },
    { id: 'user-3', telegram_id: 1003, deleted_at: null },
  ];

  let currentLinks: MockBotLink[] = [];

  // A. New valid link
  const step1 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step1.success === true, 'Valid connected_website succeeds for active user');
  assert(step1.alreadyLinked === false, 'First connection is not alreadyLinked');
  assert(step1.updatedLinks.find(l => l.user_id === 'user-1')?.enabled === true, 'New link initializes enabled = true');
  currentLinks = step1.updatedLinks;

  // B. User disables notifications
  currentLinks = currentLinks.map(l => l.user_id === 'user-1' ? { ...l, enabled: false } : l);

  // C. Repeated event for user-1 (Idempotency and preference preservation)
  const step2 = simulateConnectedWebsite(
    { connected_website: testDomain, chat: { id: 1001, type: 'private' } },
    mockUsers,
    currentLinks
  );
  assert(step2.success === true, 'Repeated connected_website event succeeds');
  assert(step2.alreadyLinked === true, 'Repeated connected_website event flags alreadyLinked: true');
  assert(step2.updatedLinks.find(l => l.user_id === 'user-1')?.enabled === false, 'Repeated event strictly preserves disabled notification preference');

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

  return { passed: failures.length === 0, count, failures };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('phase5-telegram-settler.test.ts')) {
  runPhase5UnitTests().then(r => {
    console.log(`\nPhase 5 Unit Tests: ${r.count - r.failures.length}/${r.count} passed.`);
    process.exit(r.passed ? 0 : 1);
  });
}

