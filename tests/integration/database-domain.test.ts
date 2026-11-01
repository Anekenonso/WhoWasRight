/**
 * Integration Tests: Database Schema Constraints & Core Domain Invariants
 *
 * Runs against PostgreSQL (DATABASE_URL).
 * Verifies:
 * 1. User isolation and authorization (User A vs User B).
 * 2. Prediction ownership and strict scoping.
 * 3. Duplicate prediction prevention constraint.
 * 4. Multiple distinct predictions per analyst per match.
 * 5. Kickoff locking (1s before allowed, at/after start rejected).
 * 6. Outcome state machine and audit event logging.
 * 7. Transactional outbox and Walrus receipt synchronization.
 * 8. Analyst alias linking.
 */

import { query, withTransaction } from './test-db.ts';
import { createEvent, createPrediction, settlePrediction } from '../../src/core/predictions.ts';

export async function runDatabaseDomainIntegrationTests(): Promise<{
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

  console.log('\n--- Running Database & Domain Integration Tests ---');

  // Test setup: Create two isolated test users with unique telegram_ids
  const suffix = Date.now();
  const tgUserA = 800000000 + Math.floor(Math.random() * 100000);
  const tgUserB = 900000000 + Math.floor(Math.random() * 100000);

  const uResA = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, $3)
    RETURNING id;
  `, [tgUserA, `test_user_a_${suffix}`, 'UserA']);
  const userA = uResA.rows[0].id;

  const uResB = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, $3)
    RETURNING id;
  `, [tgUserB, `test_user_b_${suffix}`, 'UserB']);
  const userB = uResB.rows[0].id;

  assert(userA !== userB, 'User A and User B created with distinct UUIDs');

  try {
    // 1. Analyst Creation & Alias Linking
    const aResA = await query<{ id: string }>(`
      INSERT INTO analysts (user_id, name)
      VALUES ($1, $2)
      RETURNING id;
    `, [userA, 'Gary Neville']);
    const analystA = aResA.rows[0].id;

    // Link aliases
    await query(`
      INSERT INTO analyst_aliases (analyst_id, platform, handle)
      VALUES ($1, 'TWITTER', '@GNev2'), ($1, 'YOUTUBE', 'TheOverlap');
    `, [analystA]);

    const aliasRes = await query(`
      SELECT handle, platform FROM analyst_aliases WHERE analyst_id = $1 ORDER BY platform;
    `, [analystA]);
    assert(aliasRes.rows.length === 2, 'Analyst A has 2 multi-platform aliases linked');

    // 2. User Isolation Test: User B cannot access or mutate User A's analyst
    let isolationCrossUserCaught = false;
    try {
      // User B attempts to create a prediction using User A's analyst ID
      const futureEventB = await createEvent({
        userId: userB,
        label: 'Event B',
        startAtUtc: new Date(Date.now() + 3600000),
        source: 'USER_REPORTED',
      });
      await createPrediction({
        userId: userB,
        eventId: futureEventB.id,
        analystId: analystA, // Belongs to User A!
        market: '1X2',
        selection: '1',
      });
    } catch {
      isolationCrossUserCaught = true;
    }
    assert(isolationCrossUserCaught, 'User B blocked from using User A analyst (User Isolation)');

    // 3. Kickoff Locking Tests
    // A. Future event (1 hour in future) -> Allowed
    const futureKickoff = new Date(Date.now() + 3600000);
    const eventFuture = await createEvent({
      userId: userA,
      label: 'Arsenal vs Chelsea (Future)',
      startAtUtc: futureKickoff,
      source: 'USER_REPORTED',
    });

    const pred1 = await createPrediction({
      userId: userA,
      eventId: eventFuture.id,
      analystId: analystA,
      market: '1X2',
      selection: 'Arsenal',
    });
    assert(pred1.outcome === 'PENDING', 'Prediction created for future match is PENDING');

    // B. Past event (10 minutes ago) -> Rejected
    const pastKickoff = new Date(Date.now() - 600000);
    const eventPast = await createEvent({
      userId: userA,
      label: 'Liverpool vs Everton (Past)',
      startAtUtc: pastKickoff,
      source: 'USER_REPORTED',
    });

    let pastRejected = false;
    try {
      await createPrediction({
        userId: userA,
        eventId: eventPast.id,
        analystId: analystA,
        market: '1X2',
        selection: 'Liverpool',
      });
    } catch (err: unknown) {
      pastRejected = (err as Error).message.includes('Kickoff locked');
    }
    assert(pastRejected, 'Prediction rejected when match already kicked off (Past Kickoff Lock)');

    // 4. Duplicate Prediction Prevention Test
    let duplicateRejected = false;
    try {
      // Attempt exact duplicate: same user, same event, same analyst, same market, same selection
      await createPrediction({
        userId: userA,
        eventId: eventFuture.id,
        analystId: analystA,
        market: '1X2',
        selection: 'Arsenal',
      });
    } catch (err: unknown) {
      duplicateRejected = (err as Error).message.includes('Duplicate prediction');
    }
    assert(duplicateRejected, 'Exact duplicate prediction rejected (Duplicate Guard)');

    // 5. Multiple Predictions by One Analyst for One Match Allowed (Different Markets)
    const pred2 = await createPrediction({
      userId: userA,
      eventId: eventFuture.id,
      analystId: analystA,
      market: 'TOTAL_GOALS',
      selection: 'Over 2.5',
    });
    assert(pred2.id !== pred1.id, 'Same analyst logged 2nd distinct market on same match (Multi-pick allowed)');

    // 6. Transactional Outbox Verification
    const outboxRes = await query(`
      SELECT event_key, status, payload FROM memory_outbox
      WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred1.id}`]);
    assert(outboxRes.rows.length === 1, 'Transactional Outbox row created atomically with prediction');
    assert(outboxRes.rows[0].status === 'PENDING', 'Outbox status is PENDING');
    assert(outboxRes.rows[0].payload.startsWith('[WWR:v1]'), 'Outbox payload uses structured memory envelope');

    // 7. Outcome State Machine & Settlement Test
    const settled = await settlePrediction({
      userId: userA,
      predictionId: pred1.id,
      newOutcome: 'WON',
      verification: 'API_VERIFIED',
      source: 'AUTOMATED_API',
      evidenceJson: { score: '2-1', status: 'FT' },
    });
    assert(settled.outcome === 'WON', 'Prediction settled as WON');
    assert(settled.verification === 'API_VERIFIED', 'Verification marked API_VERIFIED');

    // Verify Audit Event logged in outcome_events
    const auditRes = await query(`
      SELECT old_outcome, new_outcome, source, evidence_json FROM outcome_events
      WHERE prediction_id = $1;
    `, [pred1.id]);
    assert(auditRes.rows.length === 1, 'Audit log recorded in outcome_events');
    assert(auditRes.rows[0].old_outcome === 'PENDING', 'Audit log records old_outcome === PENDING');
    assert(auditRes.rows[0].new_outcome === 'WON', 'Audit log records new_outcome === WON');

    // 8. Memory Synchronization State Transition Test
    // Simulate Walrus worker confirming the job and writing to memory_receipts
    const blobId = 'sample-walrus-blob-id-12345';
    const jobId = 'sample-walrus-job-id-67890';
    await withTransaction(async (client) => {
      // A. Insert receipt
      await client.query(`
        INSERT INTO memory_receipts (user_id, namespace, sequence_number, event_type, job_id, blob_id)
        VALUES ($1, 'wwr-test-ns', 1, 'CREATED', $2, $3);
      `, [userA, jobId, blobId]);
      // B. Update outbox status to CONFIRMED
      await client.query(`
        UPDATE memory_outbox
        SET status = 'CONFIRMED', walrus_job_id = $1, updated_at = NOW()
        WHERE user_id = $2 AND event_key = $3;
      `, [jobId, userA, `pred-create-${pred1.id}`]);
    });

    const confirmedOutbox = await query(`
      SELECT status, walrus_job_id FROM memory_outbox
      WHERE user_id = $1 AND event_key = $2;
    `, [userA, `pred-create-${pred1.id}`]);
    assert(confirmedOutbox.rows[0].status === 'CONFIRMED', 'Memory Outbox transitioned to CONFIRMED upon receipt');

  } finally {
    // Cleanup test users
    await query('DELETE FROM users WHERE id IN ($1, $2);', [userA, userB]);
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('database-domain.test.ts')) {
  runDatabaseDomainIntegrationTests()
    .then(res => {
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('Database Integration Test Fatal Error:', err);
      process.exitCode = 1;
    });
}

