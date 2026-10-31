/**
 * Integration Tests: Walrus Integrity Fail-Closed Verification
 *
 * Verifies all 6 core requirements:
 * 1. Successful reconstruction: returns status 'VERIFIED', verified: true, tampered: 0, gaps: [].
 * 2. Temporary failure (network, DNS, service, db): returns status 'UNAVAILABLE', verified: false, tampered: 0, gaps: [].
 *    MUST NOT classify temporary infrastructure failure as tampering.
 * 3. Malformed receipt: returns status 'FAILED', verified: false, tampered >= 1.
 * 4. Confirmed mismatch (ciphertext or auth tag corrupted): returns status 'FAILED', verified: false, tampered >= 1.
 * 5. Detected gap (missing sequence number): returns status 'FAILED', verified: false, gaps.length > 0.
 * 6. Recovery after temporary failure: returns 'UNAVAILABLE' on failure, then cleanly recovers to 'VERIFIED' once service is restored.
 * 7. Web API `/api/analysts/:id` exposes the complete 3-way integrity object.
 * 8. HTML UI defaults fail closed without presenting unearned verification badges.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { query } from '../../src/core/db.ts';
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

  console.log('\n--- Running Walrus Integrity Fail-Closed Integration Tests ---');

  const testKey = getAppEncryptionKey();
  const testUserId = randomUUID();
  let analystId = '';
  let server: http.Server | null = null;
  const PORT = 3995;
  const baseUrl = `http://localhost:${PORT}`;

  try {
    // 0. Setup: Create test user and analyst
    await query(`
      INSERT INTO users (id, telegram_id, username, created_at)
      VALUES ($1, $2, $3, NOW());
    `, [testUserId, Math.floor(Math.random() * 800000000) + 100000000, `test_walrus_${Date.now()}`]);

    const analyst = await createAnalyst(testUserId, 'Gary Neville');
    analystId = analyst.id;

    // Build valid memories
    const validMem1 = formatStructuredMemory({
      analystId,
      eventType: 'CREATED',
      sequenceNumber: 1,
      payload: { predictionId: 'pred-001', market: '1X2', selection: 'Arsenal', createdAt: new Date().toISOString() },
      key: testKey,
    });

    const validMem2 = formatStructuredMemory({
      analystId,
      eventType: 'SETTLED',
      sequenceNumber: 2,
      payload: { predictionId: 'pred-001', outcome: 'WON', verification: 'API_VERIFIED', settledAt: new Date().toISOString() },
      key: testKey,
    });

    // -------------------------------------------------------------------------
    // TEST 1: Successful Reconstruction
    // -------------------------------------------------------------------------
    const successReport = await reconstructUserHistoryFromWalrus(testUserId, analystId, {
      rawMemoriesOverride: [validMem1, validMem2],
    });
    assert(successReport.success === true, 'Test 1a: Successful Walrus reconstruction succeeds');
    assert(successReport.tamperedEventsCount === 0, 'Test 1b: 0 tampered events in valid history');
    assert(successReport.sequenceGapsDetected.length === 0, 'Test 1c: 0 sequence gaps in valid history');

    const verifiedDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => successReport,
    });
    assert(verifiedDetail !== null, 'Test 1d: Analyst detail returned');
    assert(verifiedDetail?.integrity?.verified === true, 'Test 1e: verified is true on successful reconstruction');
    assert(verifiedDetail?.integrity?.status === 'VERIFIED', 'Test 1f: status is VERIFIED on successful reconstruction');
    assert(verifiedDetail?.integrity?.tampered === 0, 'Test 1g: tampered count is 0');
    assert(verifiedDetail?.integrity?.gaps?.length === 0, 'Test 1h: gaps array is empty');

    // -------------------------------------------------------------------------
    // TEST 2: Temporary Failure (Network / DNS / Service / DB exception)
    // -------------------------------------------------------------------------
    // Must fail closed (verified: false), set status UNAVAILABLE, and NOT classify as tampering!
    const tempFailureDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => {
        throw new Error('getaddrinfo ENOTFOUND relayer.memory.walrus.xyz');
      },
    });
    assert(tempFailureDetail?.integrity?.verified === false, 'Test 2a: Temporary network failure fails closed (verified is false, NEVER true)');
    assert(tempFailureDetail?.integrity?.status === 'UNAVAILABLE', 'Test 2b: Temporary failure status is UNAVAILABLE');
    assert(tempFailureDetail?.integrity?.tampered === 0, 'Test 2c: Temporary failure is NOT classified as tampering (tampered: 0)');
    assert(tempFailureDetail?.integrity?.gaps?.length === 0, 'Test 2d: Temporary failure reports no sequence gaps (gaps: [])');
    assert(
      (tempFailureDetail?.integrity?.warning || '').includes('temporarily unavailable') ||
      (tempFailureDetail?.integrity?.warning || '').includes('ENOTFOUND'),
      'Test 2e: Temporary failure provides informative warning'
    );

    // Also verify when reconstructUserHistoryFromWalrus throws errorOverride
    let caughtWorkerError = false;
    try {
      await reconstructUserHistoryFromWalrus(testUserId, analystId, {
        errorOverride: new Error('PostgreSQL connection timeout'),
      });
    } catch {
      caughtWorkerError = true;
    }
    assert(caughtWorkerError, 'Test 2f: reconstructUserHistoryFromWalrus propagates infrastructure exceptions to caller');

    const dbFailureDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => {
        return reconstructUserHistoryFromWalrus(testUserId, analystId, {
          errorOverride: new Error('PostgreSQL connection pool exhausted'),
        });
      },
    });
    assert(dbFailureDetail?.integrity?.verified === false, 'Test 2g: DB failure fails closed (verified: false)');
    assert(dbFailureDetail?.integrity?.status === 'UNAVAILABLE', 'Test 2h: DB failure status is UNAVAILABLE');
    assert(dbFailureDetail?.integrity?.tampered === 0, 'Test 2i: DB failure reports 0 tampering');

    // -------------------------------------------------------------------------
    // TEST 3: Malformed Receipt
    // -------------------------------------------------------------------------
    const malformedMem = '[WWR:v1] [corrupted-header-garbage-no-tag]';
    const malformedReport = reconstructFromWalrusMemories([malformedMem], analystId, testKey);
    assert(malformedReport.success === false, 'Test 3a: Malformed memory fails reconstruction');
    assert(malformedReport.tamperedEventsCount >= 1, 'Test 3b: Malformed memory incremented tampered count');

    const malformedDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => malformedReport,
    });
    assert(malformedDetail?.integrity?.verified === false, 'Test 3c: Malformed receipt fails closed (verified: false)');
    assert(malformedDetail?.integrity?.status === 'FAILED', 'Test 3d: Malformed receipt status is FAILED');
    assert((malformedDetail?.integrity?.tampered ?? 0) >= 1, 'Test 3e: Malformed receipt records tampered count >= 1');

    // -------------------------------------------------------------------------
    // TEST 4: Confirmed Mismatch (Corrupted Ciphertext / Auth Tag)
    // -------------------------------------------------------------------------
    // Tamper with the authentication tag of validMem1
    const tamperedMem = validMem1.replace(
      /\[enc:([^:]+):([^:]+):([a-f0-9]{6})/,
      '[enc:$1:$2:000000'
    );
    const tamperedReport = reconstructFromWalrusMemories([tamperedMem], analystId, testKey);
    assert(tamperedReport.success === false, 'Test 4a: Corrupted ciphertext/tag fails reconstruction');
    assert(tamperedReport.tamperedEventsCount >= 1, 'Test 4b: Cryptographic mismatch flagged as tampered');

    const tamperedDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => tamperedReport,
    });
    assert(tamperedDetail?.integrity?.verified === false, 'Test 4c: Tampered memory fails closed (verified: false)');
    assert(tamperedDetail?.integrity?.status === 'FAILED', 'Test 4d: Tampered memory status is FAILED');
    assert((tamperedDetail?.integrity?.tampered ?? 0) >= 1, 'Test 4e: Tampered memory records tampered count >= 1');

    // -------------------------------------------------------------------------
    // TEST 5: Detected Gap (Missing sequence number)
    // -------------------------------------------------------------------------
    // Sequence 1 followed by Sequence 3 (missing Sequence 2)
    const gapMem3 = formatStructuredMemory({
      analystId,
      eventType: 'SETTLED',
      sequenceNumber: 3,
      payload: { predictionId: 'pred-001', outcome: 'WON', verification: 'API_VERIFIED' },
      key: testKey,
    });
    const gapReport = reconstructFromWalrusMemories([validMem1, gapMem3], analystId, testKey);
    assert(gapReport.success === false, 'Test 5a: Sequence gap detected');
    assert(gapReport.sequenceGapsDetected.includes(2), 'Test 5b: Missing sequence 2 detected in gaps');

    const gapDetail = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: async () => gapReport,
    });
    assert(gapDetail?.integrity?.verified === false, 'Test 5c: Sequence gap fails closed (verified: false)');
    assert(gapDetail?.integrity?.status === 'FAILED', 'Test 5d: Sequence gap status is FAILED');
    assert(gapDetail?.integrity?.gaps?.includes(2) === true, 'Test 5e: Gaps array contains missing sequence 2');

    // -------------------------------------------------------------------------
    // TEST 6: Recovery After Temporary Failure
    // -------------------------------------------------------------------------
    let transientServiceHealthy = false;
    const dynamicReconstructionService = async () => {
      if (!transientServiceHealthy) {
        throw new Error('503 Service Unavailable: Walrus relayer rate limit');
      }
      return successReport;
    };

    // Call 1: Service is down
    const attempt1 = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: dynamicReconstructionService,
    });
    assert(attempt1?.integrity?.status === 'UNAVAILABLE', 'Test 6a: First attempt reflects UNAVAILABLE');
    assert(attempt1?.integrity?.verified === false, 'Test 6b: First attempt is not verified');
    assert(attempt1?.integrity?.tampered === 0, 'Test 6c: First attempt has 0 tampered');

    // Service recovers
    transientServiceHealthy = true;

    // Call 2: Service has recovered
    const attempt2 = await getAnalystDetail(testUserId, analystId, {
      reconstructOverride: dynamicReconstructionService,
    });
    assert(attempt2?.integrity?.status === 'VERIFIED', 'Test 6d: Second attempt cleanly recovers to VERIFIED');
    assert(attempt2?.integrity?.verified === true, 'Test 6e: Second attempt is verified');
    assert(attempt2?.integrity?.tampered === 0, 'Test 6f: Recovered state has 0 tampered');
    assert(attempt2?.integrity?.gaps?.length === 0, 'Test 6g: Recovered state has 0 gaps');

    // -------------------------------------------------------------------------
    // TEST 7: Web API Endpoint `/api/analysts/:id` exposes 3-way integrity object
    // -------------------------------------------------------------------------
    server = createWebServer();
    await new Promise<void>(resolve => server!.listen(PORT, resolve));

    // Create session token for test user
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    await query(`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, NOW() + interval '24 hours');
    `, [testUserId, tokenHash]);

    const apiRes = await fetch(`${baseUrl}/api/analysts/${analystId}`, {
      headers: {
        'Authorization': `Bearer ${rawToken}`,
      },
    });
    assert(apiRes.status === 200, 'Test 7a: GET /api/analysts/:id returns 200');
    const apiData = await apiRes.json() as any;
    assert(apiData.integrity !== undefined, 'Test 7b: API response contains integrity field');
    assert(typeof apiData.integrity.status === 'string', 'Test 7c: API response contains integrity.status');
    assert(typeof apiData.integrity.verified === 'boolean', 'Test 7d: API response contains integrity.verified');
    assert(Array.isArray(apiData.integrity.gaps), 'Test 7e: API response contains integrity.gaps array');
    assert(typeof apiData.integrity.tampered === 'number', 'Test 7f: API response contains integrity.tampered number');

    // -------------------------------------------------------------------------
    // TEST 8: HTML UI Fail-Closed Defaults
    // -------------------------------------------------------------------------
    const htmlRes = await fetch(`${baseUrl}/`);
    assert(htmlRes.status === 200, 'Test 8a: GET / returns 200');
    const html = await htmlRes.text();
    assert(
      html.includes('id="detail-walrus-status"') && html.includes('badge-not-rated'),
      'Test 8b: UI template initializes detail-walrus-status as badge-not-rated (not verified)'
    );
    assert(
      html.includes('id="detail-integrity-banner"') && html.includes('hidden'),
      'Test 8c: UI template initializes detail-integrity-banner as hidden'
    );
    assert(
      !html.includes('<span class="badge badge-verified" id="detail-walrus-status">✓ Confirmed on Mainnet</span>'),
      'Test 8d: UI template does NOT hardcode unearned "✓ Confirmed on Mainnet" badge'
    );

  } finally {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    // Cleanup test user and associated rows
    await query('DELETE FROM users WHERE id = $1;', [testUserId]);
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
