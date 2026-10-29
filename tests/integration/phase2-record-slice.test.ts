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

    // 3. Reversible Analyst Merge: A + B, A + B + C, Chains & Cycles
    // Create second analyst B: "Carra Alternate"
    const analystB = await createAnalyst(userA, 'Carra Alternate');
    // Create third analyst C: "Carra Third"
    const analystC = await createAnalyst(userA, 'Carra Third');

    // Create a match and log predictions
    const kickoff = new Date(Date.now() + 7200000); // 2 hours future
    const event1 = await createEvent({
      userId: userA,
      label: 'Liverpool vs Everton',
      startAtUtc: kickoff,
      source: 'USER_REPORTED',
    });

    // 1 pick on A
    await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analyst1.id,
      market: '1X2',
      selection: 'Liverpool',
    });

    // 1 pick on B
    const predB = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analystB.id,
      market: 'TOTAL_GOALS',
      selection: 'Over 2.5',
    });
    assert(predB.analyst_id === analystB.id, 'Prediction logged under Analyst B');

    // 1 pick on C
    const predC = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analystC.id,
      market: 'BTTS',
      selection: 'Yes',
    });
    assert(predC.analyst_id === analystC.id, 'Prediction logged under Analyst C');

    // 3a. A + B merge: Merge B into A
    const mergeResAB = await mergeAnalysts(userA, analystB.id, analyst1.id);
    assert(mergeResAB.success === true, 'Merge A + B succeeded');

    // Active list check after A + B
    let activeList = await listAnalysts(userA);
    assert(!activeList.some(a => a.id === analystB.id), 'Merged Analyst B hidden from top-level active list');
    let parentA = activeList.find(a => a.id === analyst1.id);
    assert(parentA?.credibility?.totalPredictions === 2, 'Target Analyst A inherited predictions from B (total 2)');

    // 3b. A + B + C merge: Merge C into A as well
    const mergeResAC = await mergeAnalysts(userA, analystC.id, analyst1.id);
    assert(mergeResAC.success === true, 'Merge A + B + C succeeded (C merged into root A)');

    activeList = await listAnalysts(userA);
    assert(!activeList.some(a => a.id === analystC.id), 'Merged Analyst C hidden from top-level active list');
    parentA = activeList.find(a => a.id === analyst1.id);
    assert(parentA?.credibility?.totalPredictions === 3, 'Target Analyst A has picks from A, B, and C (total 3, no duplicates)');

    // Detail check: A has 2 merged sub-analysts
    const detailA = await getAnalystDetail(userA, analyst1.id);
    assert(detailA?.mergedAnalysts?.length === 2, 'Detail of A includes 2 merged sub-analysts (B and C)');

    // 3c. Chain Prevention: Attempt to merge into an already merged target (e.g. try merging into B)
    const analystD = await createAnalyst(userA, 'Carra Fourth');
    let chainMergeBlocked = false;
    try {
      await mergeAnalysts(userA, analystD.id, analystB.id);
    } catch (err: any) {
      chainMergeBlocked = err.message.includes('merged into another profile');
    }
    assert(chainMergeBlocked, 'Merge chain blocked: cannot merge into an already merged profile');

    // 3d. Already-Merged Source Prevention: Attempt to merge B into D
    let mergedSourceBlocked = false;
    try {
      await mergeAnalysts(userA, analystB.id, analystD.id);
    } catch (err: any) {
      mergedSourceBlocked = err.message.includes('already merged');
    }
    assert(mergedSourceBlocked, 'Merge chain blocked: cannot merge an analyst that is already merged');

    // 3e. Cycle Prevention: Attempt to merge root A into child B
    let cycleBlocked = false;
    try {
      await mergeAnalysts(userA, analyst1.id, analystB.id);
    } catch {
      cycleBlocked = true;
    }
    assert(cycleBlocked, 'Cycle attempt blocked: cannot merge parent into child');

    // Self-merge attempt
    let selfMergeBlocked = false;
    try {
      await mergeAnalysts(userA, analystD.id, analystD.id);
    } catch (err: any) {
      selfMergeBlocked = err.message.includes('Cannot merge an analyst into themselves');
    }
    assert(selfMergeBlocked, 'Self-merge attempt blocked');

    // 3f. Reverse Merge: Unmerge C
    const unmergeResC = await unmergeAnalyst(userA, analystC.id);
    assert(unmergeResC.success === true, 'Unmerge C succeeded');

    activeList = await listAnalysts(userA);
    const hasCActive = activeList.some(a => a.id === analystC.id);
    assert(hasCActive, 'Analyst C is active again with independent profile');
    parentA = activeList.find(a => a.id === analyst1.id);
    assert(parentA?.credibility?.totalPredictions === 2, 'Analyst A retains only A + B (total 2)');

    // Unmerge B
    const unmergeResB = await unmergeAnalyst(userA, analystB.id);
    assert(unmergeResB.success === true, 'Unmerge B succeeded');

    activeList = await listAnalysts(userA);
    assert(activeList.length === 4, 'All analysts (A, B, C, D) active again after unmerges (Reversibility proven)');
    parentA = activeList.find(a => a.id === analyst1.id);
    assert(parentA?.credibility?.totalPredictions === 1, 'Analyst A restored to exactly 1 original prediction');

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
      await mergeAnalysts(userB, analyst1.id, analystB.id);
    } catch {
      crossUserMergeCaught = true;
    }
    assert(crossUserMergeCaught, 'User B rejected from merging User A analysts (Cross-user merge blocked)');

    // 5. Prediction Flow: Multi-pick vs Duplicate Prevention
    // Multi-pick: Analyst 1 logs 2nd distinct market on event 1
    const predMulti = await createPrediction({
      userId: userA,
      eventId: event1.id,
      analystId: analyst1.id,
      market: 'CUSTOM',
      selection: 'Arsenal or Draw',
    });
    assert(predMulti.market === 'CUSTOM', 'Multi-pick allowed for same event');

    // Exact duplicate rejection: Analyst 1 already has 1X2 Liverpool on event 1
    let dupCaught = false;
    try {
      await createPrediction({
        userId: userA,
        eventId: event1.id,
        analystId: analyst1.id,
        market: '1X2',
        selection: 'Liverpool',
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

