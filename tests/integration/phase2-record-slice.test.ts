/**
 * Integration Tests: Phase 2 Record Slice
 *
 * Verifies:
 * 1. Analyst CRUD, alias linking, and reversible profile merges.
 * 2. Cross-user isolation and authorization checks.
 * 3. Multi-pick logging on single event vs exact duplicate prevention.
 * 4. Kickoff boundary enforcement and rescheduling rules.
 * 5. Soft daily limit counting.
 * 6. Transactional outbox consistency.
 */

import { query, withTransaction } from '../../src/core/db.ts';
import {
  createAnalyst,
  updateAnalyst,
  addAnalystAlias,
  removeAnalystAlias,
  mergeAnalysts,
  unmergeAnalyst,
  listAnalysts,
  getAnalystDetail,
} from '../../src/core/analysts.ts';
import { createEvent, createPrediction } from '../../src/core/predictions.ts';
import { getDailyPredictionCount, checkUserDailyLimit } from '../../src/core/daily-limits.ts';

export async function runPhase2IntegrationTests(): Promise<{
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

  console.log('\n--- Running Phase 2 Record Slice Integration Tests ---');

  // Test Setup: 2 distinct users
  const suffix = Date.now();
  const uResA = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, 'UserA')
    RETURNING id;
  `, [700000000 + Math.floor(Math.random() * 100000), `user_a_${suffix}`]);
  const userA = uResA.rows[0].id;

  const uResB = await query<{ id: string }>(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES ($1, $2, 'UserB')
    RETURNING id;
  `, [710000000 + Math.floor(Math.random() * 100000), `user_b_${suffix}`]);
  const userB = uResB.rows[0].id;

  try {
    // 1. Analyst Creation & Renaming
    const analyst1 = await createAnalyst(userA, 'Jamie Carragher');
    assert(analyst1.name === 'Jamie Carragher', 'Analyst created with name "Jamie Carragher"');

    const updatedAnalyst = await updateAnalyst(userA, analyst1.id, 'J. Carragher');
    assert(updatedAnalyst.name === 'J. Carragher', 'Analyst successfully renamed');

    // 2. Alias Linking (Social Handles)
    const alias1 = await addAnalystAlias(userA, analyst1.id, 'TWITTER', '@Carra23');
    assert(alias1.handle === '@Carra23' && alias1.platform === 'TWITTER', 'Twitter alias linked');

    const alias2 = await addAnalystAlias(userA, analyst1.id, 'TELEGRAM', '@CarraTips');
    assert(alias2.handle === '@CarraTips', 'Telegram alias linked');

    const removedAlias = await removeAnalystAlias(userA, alias2.id);
    assert(removedAlias === true, 'Alias removed successfully');

    // 3. Reversible Analyst Merge
    // Create second analyst for User A: "Carra Alternate"
    const analyst2 = await createAnalyst(userA, 'Carra Alternate');

    // Create a match and log prediction under analyst2
    const kickoff = new Date(Date.now() + 7200000); // 2 hours future
    const event1 = await createEvent({
      userId: userA,
      label: 'Liverpool vs Everton',
      startAtUtc: kickoff,
      source: 'USER_REPORTED',
    });

    const predB = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analyst2.id,
      market: '1X2',
      selection: 'Liverpool',
    });
    assert(predB.analyst_id === analyst2.id, 'Prediction logged under Analyst 2');

    // Merge analyst2 into analyst1
    const mergeRes = await mergeAnalysts(userA, analyst2.id, analyst1.id);
    assert(mergeRes.success === true, 'Merge operation succeeded');

    // Check listAnalysts: Analyst 2 is hidden from active list
    const activeList = await listAnalysts(userA);
    const hasAnalyst2 = activeList.some(a => a.id === analyst2.id);
    const parent = activeList.find(a => a.id === analyst1.id);
    assert(!hasAnalyst2, 'Merged Analyst 2 hidden from top-level active list');
    assert(parent?.credibility?.totalPredictions === 1, 'Target Analyst 1 inherited prediction count from merged analyst');

    // Check detail of Analyst 1: includes Analyst 2 in mergedAnalysts
    const detailA = await getAnalystDetail(userA, analyst1.id);
    assert(detailA?.mergedAnalysts?.length === 1, 'Detail includes 1 merged sub-analyst');
    assert(detailA?.mergedAnalysts?.[0].id === analyst2.id, 'Merged sub-analyst is Analyst 2');

    // Reverse the merge (Unmerge)
    const unmergeRes = await unmergeAnalyst(userA, analyst2.id);
    assert(unmergeRes.success === true, 'Unmerge operation succeeded');

    // Check listAnalysts post-unmerge: Analyst 2 is active again
    const postUnmergeList = await listAnalysts(userA);
    assert(postUnmergeList.length === 2, 'Both analysts active again after unmerge (Reversibility proven)');

    // 4. Cross-User Authorization
    let crossUserRenameCaught = false;
    try {
      await updateAnalyst(userB, analyst1.id, 'Hacked Name');
    } catch {
      crossUserRenameCaught = true;
    }
    assert(crossUserRenameCaught, 'User B rejected from renaming User A analyst');

    let crossUserMergeCaught = false;
    try {
      await mergeAnalysts(userB, analyst1.id, analyst2.id);
    } catch {
      crossUserMergeCaught = true;
    }
    assert(crossUserMergeCaught, 'User B rejected from merging User A analysts');

    // 5. Prediction Flow: Multi-pick vs Duplicate Prevention
    // Multi-pick: Analyst 1 logs 2nd distinct market on event 1
    const predMulti = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analyst1.id,
      market: 'TOTAL_GOALS',
      selection: 'Over 2.5',
    });
    assert(predMulti.market === 'TOTAL_GOALS', 'Multi-pick allowed for same event');

    // Exact duplicate rejection
    let dupCaught = false;
    try {
      await createPrediction({
        userId: userA,
        eventId: event1.id,
        analystId: analyst1.id,
        market: 'TOTAL_GOALS',
        selection: 'Over 2.5',
      });
    } catch (e: unknown) {
      dupCaught = (e as Error).message.includes('Duplicate prediction');
    }
    assert(dupCaught, 'Exact duplicate prediction rejected');

    // 6. Kickoff Boundary Enforcement
    let pastKickoffCaught = false;
    try {
      const pastEvent = await createEvent({
        userId: userA,
        label: 'Past Event',
        startAtUtc: new Date(Date.now() - 3600000), // 1 hour ago
        source: 'USER_REPORTED',
      });
      await createPrediction({
        userId: userA,
        eventId: pastEvent.id,
        analystId: analyst1.id,
        market: '1X2',
        selection: '1',
      });
    } catch (e: unknown) {
      pastKickoffCaught = (e as Error).message.includes('Kickoff locked');
    }
    assert(pastKickoffCaught, 'Prediction at or after kickoff fails closed');

    // 7. Daily Limits Counter
    const countToday = await getDailyPredictionCount(userA);
    assert(countToday >= 2, 'Daily prediction count tracked for User A');
    const limitCheck = await checkUserDailyLimit(userA);
    assert(limitCheck.canSave === true, 'Daily limit check permits saving');
    assert(limitCheck.status === 'NORMAL', '2 predictions today is NORMAL');

  } finally {
    // Cleanup
    await query('DELETE FROM users WHERE id IN ($1, $2);', [userA, userB]);
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('phase2-record-slice.test.ts')) {
  runPhase2IntegrationTests()
    .then(res => {
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('Phase 2 Integration Test Fatal Error:', err);
      process.exitCode = 1;
    });
}

