/**
 * Integration Tests: Walrus Integrity Fail-Closed & Completeness Verification
 *
 * Verifies all 12 core requirements:
 * - Case 1: Analyst with no predictions and no receipts (NOT_APPLICABLE).
 * - Case 2: Predictions existing in PostgreSQL but no confirmed Walrus receipts (INCOMPLETE).
 * - Case 3: Partial synchronization where only some prediction creation records have receipts (INCOMPLETE).
 * - Case 4: Missing tail records where creation is confirmed but settlement is pending (INCOMPLETE).
 * - Case 5: Multiple analysts sharing one user's global sequence ([Analyst A seq 1, Analyst B seq 2, Analyst A seq 3] -> both verified).
 * - Case 6: Genuine global sequence gap ([1, 3] missing 2 -> FAILED).
 * - Case 7: Invalid cryptographic receipt (FAILED).
 * - Case 8: report.success === false without explicit tampering (FAILED).
 * - Case 9: Temporary infrastructure failure (UNAVAILABLE).
 * - Case 10: Recovery after missing records are successfully synchronized (INCOMPLETE -> VERIFIED).
 * - Case 11: UI never displays verified badge for NOT_APPLICABLE, INCOMPLETE, UNAVAILABLE, or FAILED.
 * - Case 12: No "Confirmed on Mainnet" claim in UI without independent Mainnet verification.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { query } from './test-db.ts';
import { createAnalyst, getAnalystDetail } from '../../src/core/analysts.ts';
import { reconstructUserHistoryFromWalrus } from '../../src/core/walrus-outbox-worker.ts';
import { reconstructFromWalrusMemories } from '../../src/core/walrus-reconstruction.ts';
import { formatStructuredMemory, getAppEncryptionKey, generateSessionToken, hashSessionToken } from '../../src/core/crypto.ts';
import { createWebServer } from '../../src/web/server.ts';

export async function runWalrusIntegrityFailClosedTests(): Promise<{
  passed: boolean;
  count: number;
  failures: string[];
}> {
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

  console.log('\n--- Running Walrus Integrity Fail-Closed & Completeness Integration Tests ---');

  const testKey = getAppEncryptionKey();
  const testUserId = randomUUID();
  let multiUser = '';
  let server: http.Server | null = null;
  const PORT = 3995;
  const baseUrl = `http://localhost:${PORT}`;

  try {
    // 0. Setup: Create test user and fixture event
    await query(`
      INSERT INTO users (id, telegram_id, username, created_at)
      VALUES ($1, $2, $3, NOW());
    `, [testUserId, Math.floor(Math.random() * 800000000) + 100000000, `test_walrus_${Date.now()}`]);

    const eventRes = await query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Arsenal vs Chelsea', NOW(), 'USER_REPORTED')
      RETURNING id;
    `, [testUserId]);
    const eventId = eventRes.rows[0].id;

    // -------------------------------------------------------------------------
    // CASE 1: Analyst with no predictions and no receipts (NOT_APPLICABLE)
    // -------------------------------------------------------------------------
    const emptyAnalyst = await createAnalyst(testUserId, 'Empty Analyst');
    const emptyDetail = await getAnalystDetail(testUserId, emptyAnalyst.id);

    assert(emptyDetail !== null, 'Case 1a: Empty analyst detail returned');
    assert(emptyDetail?.integrity?.verified === false, 'Case 1b: Empty analyst verified is false');
    assert(emptyDetail?.integrity?.status === 'NOT_APPLICABLE', 'Case 1c: Empty analyst status is NOT_APPLICABLE');
    assert(emptyDetail?.integrity?.tampered === 0, 'Case 1d: Empty analyst tampered count is 0');
    assert(emptyDetail?.integrity?.gaps?.length === 0, 'Case 1e: Empty analyst gaps array is empty');

    // -------------------------------------------------------------------------
    // CASE 2: Predictions in PostgreSQL but no confirmed Walrus receipts (INCOMPLETE)
    // -------------------------------------------------------------------------
    const analystA = await createAnalyst(testUserId, 'Analyst A');
    const pred1Res = await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, '1X2', 'Arsenal', 'PENDING', 'UNVERIFIED')
      RETURNING id;
    `, [testUserId, eventId, analystA.id]);
    const pred1Id = pred1Res.rows[0].id;

    // No Walrus receipts exist yet
    const pendingDetail = await getAnalystDetail(testUserId, analystA.id);
    assert(pendingDetail?.integrity?.verified === false, 'Case 2a: Missing Walrus receipts verified is false');
    assert(pendingDetail?.integrity?.status === 'INCOMPLETE', 'Case 2b: Missing Walrus receipts status is INCOMPLETE');
    assert(pendingDetail?.integrity?.tampered === 0, 'Case 2c: Missing Walrus receipts NOT flagged as tampering (tampered: 0)');
    assert(pendingDetail?.integrity?.gaps?.length === 0, 'Case 2d: Missing Walrus receipts reports no sequence gaps');
    assert((pendingDetail?.integrity?.warning || '').includes('awaiting Walrus synchronization'), 'Case 2e: Warning explains pending sync');

    // -------------------------------------------------------------------------
    // CASE 3: Partial synchronization - only some creations have receipts (INCOMPLETE)
    // -------------------------------------------------------------------------
    const pred2Res = await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, 'BTTS', 'Yes', 'PENDING', 'UNVERIFIED')
      RETURNING id;
    `, [testUserId, eventId, analystA.id]);
    const pred2Id = pred2Res.rows[0].id;

    // Walrus only has receipt for pred1, missing pred2
    const memPred1Created = formatStructuredMemory({
      analystId: analystA.id,
      eventType: 'CREATED',
      sequenceNumber: 1,
      payload: { predictionId: pred1Id, market: '1X2', selection: 'Arsenal', createdAt: new Date().toISOString() },
      key: testKey,
    });

    const partialDetail = await getAnalystDetail(testUserId, analystA.id, {
      reconstructOverride: async () => reconstructFromWalrusMemories([memPred1Created], analystA.id, testKey),
    });
    assert(partialDetail?.integrity?.verified === false, 'Case 3a: Partial sync verified is false');
    assert(partialDetail?.integrity?.status === 'INCOMPLETE', 'Case 3b: Partial sync status is INCOMPLETE');
    assert(partialDetail?.integrity?.tampered === 0, 'Case 3c: Partial sync NOT flagged as tampering');
    assert((partialDetail?.integrity?.warning || '').includes('1 prediction(s) awaiting Walrus synchronization'), 'Case 3d: Explains 1 prediction awaiting sync');

    // -------------------------------------------------------------------------
    // CASE 4: Missing tail records - creation confirmed but settlement pending (INCOMPLETE)
    // -------------------------------------------------------------------------
    // Settle pred1 in PostgreSQL as WON
    await query(`
      UPDATE predictions
      SET outcome = 'WON', verification = 'API_VERIFIED'
      WHERE id = $1;
    `, [pred1Id]);

    // Create an analyst with just pred1 settled
    const analystSettled = await createAnalyst(testUserId, 'Analyst Settled');
    const predSettledRes = await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, '1X2', 'Arsenal', 'WON', 'API_VERIFIED')
      RETURNING id;
    `, [testUserId, eventId, analystSettled.id]);
    const predSettledId = predSettledRes.rows[0].id;

    // Walrus only contains the CREATED event (settlement tail record pending)
    const memCreatedOnly = formatStructuredMemory({
      analystId: analystSettled.id,
      eventType: 'CREATED',
      sequenceNumber: 1,
      payload: { predictionId: predSettledId, market: '1X2', selection: 'Arsenal', createdAt: new Date().toISOString() },
      key: testKey,
    });

    const tailMissingDetail = await getAnalystDetail(testUserId, analystSettled.id, {
      reconstructOverride: async () => reconstructFromWalrusMemories([memCreatedOnly], analystSettled.id, testKey),
    });
    assert(tailMissingDetail?.integrity?.verified === false, 'Case 4a: Missing tail record verified is false');
    assert(tailMissingDetail?.integrity?.status === 'INCOMPLETE', 'Case 4b: Missing tail record status is INCOMPLETE');
    assert(tailMissingDetail?.integrity?.tampered === 0, 'Case 4c: Missing tail record is NOT flagged as tampering');
    assert((tailMissingDetail?.integrity?.warning || '').includes('settlement record(s) pending Walrus synchronization'), 'Case 4d: Identifies pending settlement');

    // -------------------------------------------------------------------------
    // CASE 5: Multiple analysts sharing one user's global sequence -> BOTH VERIFIED
    // Sequence numbers: [Analyst A seq 1, Analyst B seq 2, Analyst A seq 3, Analyst B seq 4]
    // -------------------------------------------------------------------------
    multiUser = randomUUID();
    await query(`
      INSERT INTO users (id, telegram_id, username, created_at)
      VALUES ($1, $2, $3, NOW());
    `, [multiUser, Math.floor(Math.random() * 800000000) + 100000000, `multi_user_${Date.now()}`]);

    const multiEvent = (await query<{ id: string }>(`
      INSERT INTO events (user_id, sport, label, start_at_utc, source)
      VALUES ($1, 'FOOTBALL', 'Liverpool vs City', NOW(), 'USER_REPORTED')
      RETURNING id;
    `, [multiUser])).rows[0].id;

    const multiAnalystA = await createAnalyst(multiUser, 'Multi Analyst A');
    const multiAnalystB = await createAnalyst(multiUser, 'Multi Analyst B');

    const predA1 = (await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, '1X2', 'Liverpool', 'WON', 'API_VERIFIED')
      RETURNING id;
    `, [multiUser, multiEvent, multiAnalystA.id])).rows[0].id;

    const predB1 = (await query<{ id: string }>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, outcome, verification)
      VALUES ($1, $2, $3, 'TOTAL_GOALS', 'Over 2.5', 'WON', 'API_VERIFIED')
      RETURNING id;
    `, [multiUser, multiEvent, multiAnalystB.id])).rows[0].id;

    // Construct interleaved global sequence:
    // Seq 1: Analyst A (create predA1)
    // Seq 2: Analyst B (create predB1)
    // Seq 3: Analyst A (settle predA1)
    // Seq 4: Analyst B (settle predB1)
    const memA_seq1 = formatStructuredMemory({
      analystId: multiAnalystA.id,
      eventType: 'CREATED',
      sequenceNumber: 1,
      payload: { predictionId: predA1, market: '1X2', selection: 'Liverpool', createdAt: new Date().toISOString() },
      key: testKey,
    });
    const memB_seq2 = formatStructuredMemory({
      analystId: multiAnalystB.id,
      eventType: 'CREATED',
      sequenceNumber: 2,
      payload: { predictionId: predB1, market: 'TOTAL_GOALS', selection: 'Over 2.5', createdAt: new Date().toISOString() },
      key: testKey,
    });
    const memA_seq3 = formatStructuredMemory({
      analystId: multiAnalystA.id,
      eventType: 'SETTLED',
      sequenceNumber: 3,
      payload: { predictionId: predA1, outcome: 'WON', verification: 'API_VERIFIED', settledAt: new Date().toISOString() },
      key: testKey,
    });
    const memB_seq4 = formatStructuredMemory({
      analystId: multiAnalystB.id,
      eventType: 'SETTLED',
      sequenceNumber: 4,
      payload: { predictionId: predB1, outcome: 'WON', verification: 'API_VERIFIED', settledAt: new Date().toISOString() },
      key: testKey,
    });

    const multiRawMemories = [memA_seq1, memB_seq2, memA_seq3, memB_seq4];

    // Reconstruct Analyst A: Personal sequence is [1, 3], but global sequence is [1, 2, 3, 4]
    const reportA = reconstructFromWalrusMemories(multiRawMemories, multiAnalystA.id, testKey);
    assert(reportA.sequenceGapsDetected.length === 0, 'Case 5a: No false sequence gap detected for Analyst A');
    assert(reportA.validEventsCount === 2, 'Case 5b: Filtered Analyst A has 2 valid projected events');

    const detailA = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: async () => reportA,
    });
    assert(detailA?.integrity?.status === 'VERIFIED', 'Case 5c: Analyst A status is VERIFIED');
    assert(detailA?.integrity?.verified === true, 'Case 5d: Analyst A verified is true');

    // Reconstruct Analyst B: Personal sequence is [2, 4], but global sequence is [1, 2, 3, 4]
    const reportB = reconstructFromWalrusMemories(multiRawMemories, multiAnalystB.id, testKey);
    assert(reportB.sequenceGapsDetected.length === 0, 'Case 5e: No false sequence gap detected for Analyst B');
    assert(reportB.validEventsCount === 2, 'Case 5f: Filtered Analyst B has 2 valid projected events');

    const detailB = await getAnalystDetail(multiUser, multiAnalystB.id, {
      reconstructOverride: async () => reportB,
    });
    assert(detailB?.integrity?.status === 'VERIFIED', 'Case 5g: Analyst B status is VERIFIED');
    assert(detailB?.integrity?.verified === true, 'Case 5h: Analyst B verified is true');

    // -------------------------------------------------------------------------
    // CASE 6: Genuine global sequence gap ([1, 3] missing 2 -> FAILED)
    // -------------------------------------------------------------------------
    // Global memories contain seq 1 and seq 3, but NO seq 2 exists anywhere for user
    const gapMemories = [memA_seq1, memA_seq3];
    const genuineGapReport = reconstructFromWalrusMemories(gapMemories, multiAnalystA.id, testKey);
    assert(genuineGapReport.success === false, 'Case 6a: Genuine global gap fails reconstruction');
    assert(genuineGapReport.sequenceGapsDetected.includes(2), 'Case 6b: Missing sequence 2 detected in global gap check');

    const genuineGapDetail = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: async () => genuineGapReport,
    });
    assert(genuineGapDetail?.integrity?.verified === false, 'Case 6c: Genuine gap fails closed (verified: false)');
    assert(genuineGapDetail?.integrity?.status === 'FAILED', 'Case 6d: Genuine gap status is FAILED');
    assert(genuineGapDetail?.integrity?.gaps?.includes(2) === true, 'Case 6e: Gaps array contains 2');

    // -------------------------------------------------------------------------
    // CASE 7: Invalid cryptographic receipt (FAILED)
    // -------------------------------------------------------------------------
    // Corrupt the ciphertext authentication tag in memA_seq1
    const tamperedMem = memA_seq1.replace(
      /\[enc:([^:]+):([^:]+):([a-f0-9]{6})/,
      '[enc:$1:$2:000000'
    );
    const tamperedReport = reconstructFromWalrusMemories([tamperedMem], multiAnalystA.id, testKey);
    assert(tamperedReport.success === false, 'Case 7a: Corrupted ciphertext/tag fails reconstruction');
    assert(tamperedReport.tamperedEventsCount >= 1, 'Case 7b: Flagged as tampered event');

    const tamperedDetail = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: async () => tamperedReport,
    });
    assert(tamperedDetail?.integrity?.verified === false, 'Case 7c: Tampered memory fails closed (verified: false)');
    assert(tamperedDetail?.integrity?.status === 'FAILED', 'Case 7d: Tampered memory status is FAILED');
    assert((tamperedDetail?.integrity?.tampered ?? 0) >= 1, 'Case 7e: Tampered count recorded in integrity status');

    // -------------------------------------------------------------------------
    // CASE 8: report.success === false without explicit tampering (FAILED)
    // -------------------------------------------------------------------------
    const unverifiedReport = {
      success: false,
      totalEventsProcessed: 2,
      validEventsCount: 0,
      tamperedEventsCount: 0,
      sequenceGapsDetected: [],
      reconstructedPredictions: {},
      credibility: { ratingTier: 'Not Rated', winRate: null, wonCount: 0, lostCount: 0, pushCount: 0, totalSettled: 0, historyBadge: 'Insufficient', apiVerifiedCount: 0, selfReportedCount: 0 },
      error: 'Unspecified batch verification error from upstream node',
    };

    const unverifiedDetail = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: async () => unverifiedReport,
    });
    assert(unverifiedDetail?.integrity?.verified === false, 'Case 8a: report.success false fails closed (verified: false)');
    assert(unverifiedDetail?.integrity?.status === 'FAILED', 'Case 8b: report.success false classified as FAILED');
    assert(unverifiedDetail?.integrity?.warning === 'Unspecified batch verification error from upstream node', 'Case 8c: Preserves error message');

    // -------------------------------------------------------------------------
    // CASE 9: Temporary infrastructure failure (UNAVAILABLE)
    // -------------------------------------------------------------------------
    const tempFailureDetail = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: async () => {
        throw new Error('getaddrinfo ENOTFOUND relayer.memory.walrus.xyz');
      },
    });
    assert(tempFailureDetail?.integrity?.verified === false, 'Case 9a: Network failure fails closed (verified: false)');
    assert(tempFailureDetail?.integrity?.status === 'UNAVAILABLE', 'Case 9b: Network failure status is UNAVAILABLE');
    assert(tempFailureDetail?.integrity?.tampered === 0, 'Case 9c: Network failure is NOT classified as tampering (tampered: 0)');
    assert(tempFailureDetail?.integrity?.gaps?.length === 0, 'Case 9d: Network failure reports no sequence gaps (gaps: [])');

    // -------------------------------------------------------------------------
    // CASE 10: Recovery after missing records are synchronized (INCOMPLETE -> VERIFIED)
    // -------------------------------------------------------------------------
    let recordsSynchronized = false;
    const dynamicSyncService = async () => {
      if (!recordsSynchronized) {
        // Only seq 1 available initially (predA1 created, but settlement missing)
        return reconstructFromWalrusMemories([memA_seq1, memB_seq2], multiAnalystA.id, testKey);
      }
      // All records synchronized
      return reconstructFromWalrusMemories(multiRawMemories, multiAnalystA.id, testKey);
    };

    // Attempt 1: Before sync completes
    const attempt1 = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: dynamicSyncService,
    });
    assert(attempt1?.integrity?.status === 'INCOMPLETE', 'Case 10a: First attempt reflects INCOMPLETE awaiting sync');
    assert(attempt1?.integrity?.verified === false, 'Case 10b: First attempt is not verified');

    // Outbox worker synchronizes missing receipts
    recordsSynchronized = true;

    // Attempt 2: After sync completes
    const attempt2 = await getAnalystDetail(multiUser, multiAnalystA.id, {
      reconstructOverride: dynamicSyncService,
    });
    assert(attempt2?.integrity?.status === 'VERIFIED', 'Case 10c: Second attempt cleanly transitions to VERIFIED');
    assert(attempt2?.integrity?.verified === true, 'Case 10d: Second attempt is verified');

    // -------------------------------------------------------------------------
    // CASE 11: UI never displays verified badge for NOT_APPLICABLE, INCOMPLETE, UNAVAILABLE, or FAILED
    // -------------------------------------------------------------------------
    server = createWebServer();
    await new Promise<void>(resolve => server!.listen(PORT, resolve));

    const htmlRes = await fetch(`${baseUrl}/`);
    assert(htmlRes.status === 200, 'Case 11a: GET / returns 200');
    const html = await htmlRes.text();

    // Verify template defaults
    assert(
      html.includes('id="detail-walrus-status"') && html.includes('badge-not-rated'),
      'Case 11b: UI template initializes detail-walrus-status as badge-not-rated'
    );
    assert(
      html.includes('id="detail-integrity-banner"') && html.includes('hidden'),
      'Case 11c: UI template initializes detail-integrity-banner as hidden'
    );

    // Verify openAnalystDetail client-side mapping:
    // Only status === 'VERIFIED' assigns 'badge badge-verified' and 'banner-success'
    assert(
      html.includes("if (integ.status === 'VERIFIED') {\n          if (walrusStatusEl) {\n            walrusStatusEl.className = 'badge badge-verified';"),
      'Case 11d: UI assigns badge-verified strictly when integ.status === "VERIFIED"'
    );
    assert(
      html.includes("else if (integ.status === 'NOT_APPLICABLE') {\n          if (walrusStatusEl) {\n            walrusStatusEl.className = 'badge badge-not-rated';"),
      'Case 11e: NOT_APPLICABLE uses badge-not-rated'
    );
    assert(
      html.includes("else if (integ.status === 'INCOMPLETE') {\n          if (walrusStatusEl) {\n            walrusStatusEl.className = 'badge badge-pending';"),
      'Case 11f: INCOMPLETE uses badge-pending'
    );
    assert(
      html.includes("else if (integ.status === 'UNAVAILABLE') {\n          if (walrusStatusEl) {\n            walrusStatusEl.className = 'badge badge-not-rated';"),
      'Case 11g: UNAVAILABLE uses badge-not-rated'
    );
    assert(
      html.includes("walrusStatusEl.className = 'badge badge-lost';\n            walrusStatusEl.textContent = '✗ Integrity Failure';"),
      'Case 11h: FAILED uses badge-lost'
    );

    // -------------------------------------------------------------------------
    // CASE 12: No "Confirmed on Mainnet" claim in UI without independent Mainnet verification
    // -------------------------------------------------------------------------
    assert(
      !html.includes('Confirmed on Mainnet'),
      'Case 12a: UI HTML and client scripts contain NO unearned "Confirmed on Mainnet" claim'
    );
    assert(
      html.includes('✓ History Integrity Verified'),
      'Case 12b: UI accurately displays "✓ History Integrity Verified" for verified status'
    );
    assert(
      html.includes('No Prediction History'),
      'Case 12c: UI accurately displays "No Prediction History" for NOT_APPLICABLE status'
    );
    assert(
      html.includes('⏳ Awaiting Walrus Sync'),
      'Case 12d: UI accurately displays "⏳ Awaiting Walrus Sync" for INCOMPLETE status'
    );

    // Clean API verification
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    await query(`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + interval '24 hours');
    `, [multiUser, tokenHash]);

    const apiRes = await fetch(`${baseUrl}/api/analysts/${multiAnalystA.id}`, {
      headers: {
        'Authorization': `Bearer ${rawToken}`,
      },
    });
    assert(apiRes.status === 200, 'Case 12e: GET /api/analysts/:id returns 200');
    const apiData = await apiRes.json() as any;
    assert(typeof apiData.integrity?.status === 'string', 'Case 12f: API returns integrity.status');
    assert(typeof apiData.integrity?.verified === 'boolean', 'Case 12g: API returns integrity.verified');

  } finally {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    // Cleanup test users and associated rows
    if (testUserId) await query('DELETE FROM users WHERE id = $1;', [testUserId]);
    if (multiUser) await query('DELETE FROM users WHERE id = $1;', [multiUser]);
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('walrus-integrity-fail-closed.test.ts')) {
  runWalrusIntegrityFailClosedTests()
    .then(r => {
      console.log(`\nWalrus Integrity Fail-Closed Tests: ${r.count - r.failures.length}/${r.count} passed.`);
      process.exit(r.passed ? 0 : 1);
    })
    .catch(err => {
      console.error('Walrus Integrity Fail-Closed Test Fatal Error:', err);
      process.exit(1);
    });
}
