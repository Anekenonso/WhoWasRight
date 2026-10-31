/**
 * Unit Tests: Automated Football Settlement Rules & Market Adjudication
 *
 * Verifies:
 * 1. 1X2 Market (Home Win, Away Win, Draw)
 * 2. BTTS Market (Yes, No, Goal/Goal)
 * 3. Total Goals Market (Over, Under, Integer line Push)
 * 4. Match status adjudication:
 *    - FINISHED: settles against authoritative full-time scores
 *    - POSTPONED: remains PENDING
 *    - ABANDONED: remains PENDING awaiting authoritative resolution
 *    - CANCELLED: transitions to VOID
 *    - SUSPENDED: must not settle prematurely; remains PENDING
 *    - WALKOVER (WO): must NOT automatically become VOID; routes to manual review
 * 5. Sequential resolution: ABANDONED remains PENDING, later authoritative FT settles
 * 6. Raw fixture status mapping in parseFixtureEvidence (CANC, PST, ABD, SUSP, WO, FT)
 * 7. Unsupported markets (player props, first goalscorer) fail safe to UNSUPPORTED_REQUIRES_MANUAL
 * 8. Never infer player-specific statistics from team scores
 */

import { adjudicateFootballPrediction, type MatchScoreEvidence } from '../../src/core/settlement.ts';
import { parseFixtureEvidence } from '../../src/core/football-settler.ts';

export function runSettlementUnitTests(): {
  passed: boolean;
  count: number;
  failures: string[];
} {
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

  console.log('\n--- Running Football Settlement & Adjudication Unit Tests ---');

  // Baseline match evidence: Arsenal 2 - 1 Chelsea (Finished FT)
  const ft21Evidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 2,
    awayGoals: 1,
    status: 'FINISHED',
    statusShort: 'FT',
  };

  // 1. 1X2 Market Adjudication
  const homeWinPick = adjudicateFootballPrediction('1X2', 'Arsenal', ft21Evidence);
  assert(homeWinPick.outcome === 'WON' && homeWinPick.verification === 'API_VERIFIED', '1X2: Home team name (Arsenal) on 2-1 is WON');

  const homeNumberPick = adjudicateFootballPrediction('1X2', '1', ft21Evidence);
  assert(homeNumberPick.outcome === 'WON', '1X2: Selection "1" on 2-1 is WON');

  const awayPick = adjudicateFootballPrediction('1X2', 'Chelsea', ft21Evidence);
  assert(awayPick.outcome === 'LOST', '1X2: Away team name (Chelsea) on 2-1 is LOST');

  const drawPick = adjudicateFootballPrediction('1X2', 'Draw', ft21Evidence);
  assert(drawPick.outcome === 'LOST', '1X2: Draw on 2-1 is LOST');

  // Draw match evidence: Liverpool 2 - 2 Man City
  const drawEvidence: MatchScoreEvidence = {
    homeTeam: 'Liverpool',
    awayTeam: 'Man City',
    homeGoals: 2,
    awayGoals: 2,
    status: 'FINISHED',
  };
  const drawOnDrawPick = adjudicateFootballPrediction('1X2', 'X', drawEvidence);
  assert(drawOnDrawPick.outcome === 'WON', '1X2: Selection "X" on 2-2 is WON');

  // 2. Both Teams to Score (BTTS)
  const bttsYesOn21 = adjudicateFootballPrediction('BTTS', 'Yes', ft21Evidence);
  assert(bttsYesOn21.outcome === 'WON', 'BTTS: "Yes" on 2-1 is WON');

  const bttsNoOn21 = adjudicateFootballPrediction('BTTS', 'No', ft21Evidence);
  assert(bttsNoOn21.outcome === 'LOST', 'BTTS: "No" on 2-1 is LOST');

  // Clean sheet evidence: Real Madrid 3 - 0 Barcelona
  const cleanSheetEvidence: MatchScoreEvidence = {
    homeTeam: 'Real Madrid',
    awayTeam: 'Barcelona',
    homeGoals: 3,
    awayGoals: 0,
    status: 'FINISHED',
  };
  const bttsYesOnCleanSheet = adjudicateFootballPrediction('BTTS', 'Yes', cleanSheetEvidence);
  assert(bttsYesOnCleanSheet.outcome === 'LOST', 'BTTS: "Yes" on 3-0 clean sheet is LOST');

  const bttsNoOnCleanSheet = adjudicateFootballPrediction('BTTS', 'No', cleanSheetEvidence);
  assert(bttsNoOnCleanSheet.outcome === 'WON', 'BTTS: "No" on 3-0 clean sheet is WON');

  // 3. Total Goals (Over/Under)
  const over25On21 = adjudicateFootballPrediction('TOTAL_GOALS', 'Over 2.5', ft21Evidence);
  assert(over25On21.outcome === 'WON', 'Total Goals: Over 2.5 on 2-1 (total 3) is WON');

  const under25On21 = adjudicateFootballPrediction('TOTAL_GOALS', 'Under 2.5', ft21Evidence);
  assert(under25On21.outcome === 'LOST', 'Total Goals: Under 2.5 on 2-1 (total 3) is LOST');

  const over35On21 = adjudicateFootballPrediction('TOTAL_GOALS', 'O 3.5', ft21Evidence);
  assert(over35On21.outcome === 'LOST', 'Total Goals: Over 3.5 on 2-1 is LOST');

  const under35On21 = adjudicateFootballPrediction('TOTAL_GOALS', 'Under 3.5', ft21Evidence);
  assert(under35On21.outcome === 'WON', 'Total Goals: Under 3.5 on 2-1 is WON');

  // Integer line Push test: 3 total goals on line 3.0
  const over3Push = adjudicateFootballPrediction('TOTAL_GOALS', 'Over 3.0', ft21Evidence);
  assert(over3Push.outcome === 'PUSH', 'Total Goals: Over 3.0 on 3 total goals is PUSH');

  const under3Push = adjudicateFootballPrediction('TOTAL_GOALS', 'Under 3', ft21Evidence);
  assert(under3Push.outcome === 'PUSH', 'Total Goals: Under 3 on 3 total goals is PUSH');

  // 4. Match Status Adjudication Contract (Audit 1)
  console.log('\n  [Section 4: Match Status Contract & Adjudication]');
  const postponedEvidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 0,
    awayGoals: 0,
    status: 'POSTPONED',
    statusShort: 'PST',
  };
  const postponedPick = adjudicateFootballPrediction('1X2', 'Arsenal', postponedEvidence);
  assert(postponedPick.outcome === 'PENDING', 'Postponed match leaves prediction as PENDING');

  const abandonedEvidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 1,
    awayGoals: 0,
    status: 'ABANDONED',
    statusShort: 'ABD',
  };
  const abandonedPick = adjudicateFootballPrediction('1X2', 'Arsenal', abandonedEvidence);
  assert(abandonedPick.outcome === 'PENDING', 'Abandoned match leaves prediction as PENDING');

  const cancelledEvidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 0,
    awayGoals: 0,
    status: 'CANCELLED',
    statusShort: 'CANC',
  };
  const cancelledPick = adjudicateFootballPrediction('1X2', 'Arsenal', cancelledEvidence);
  assert(cancelledPick.outcome === 'VOID', 'Cancelled match settles prediction as VOID');

  // Suspended match (SUSP): Must not settle prematurely; remains PENDING
  const suspendedEvidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 1,
    awayGoals: 1,
    status: 'SUSPENDED',
    statusShort: 'SUSP',
  };
  const suspendedPick = adjudicateFootballPrediction('1X2', 'Arsenal', suspendedEvidence);
  assert(suspendedPick.outcome === 'PENDING', 'Suspended match must not settle prematurely (remains PENDING)');
  assert(!suspendedPick.isDecisive, 'Suspended match adjudication is non-decisive');

  // Walkover (WO): Must NOT automatically become VOID; routes to manual review
  const walkoverEvidence: MatchScoreEvidence = {
    homeTeam: 'Arsenal',
    awayTeam: 'Chelsea',
    homeGoals: 3,
    awayGoals: 0,
    status: 'WALKOVER',
    statusShort: 'WO',
  };
  const walkoverPick = adjudicateFootballPrediction('1X2', 'Arsenal', walkoverEvidence);
  assert(walkoverPick.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'Walkover (WO) cannot be silently treated as CANCELLED/VOID; routes to manual review');
  assert(walkoverPick.reason.includes('walkover'), 'Walkover reason explicitly cites non-automatic adjudication requirement');

  // 4b. Sequential resolution: ABANDONED remains PENDING, later authoritative FINISHED settles
  const laterResolution = adjudicateFootballPrediction('1X2', 'Arsenal', ft21Evidence);
  assert(laterResolution.outcome === 'WON', 'Later authoritative FINISHED resolution settles to WON');
  assert(laterResolution.verification === 'API_VERIFIED', 'Later authoritative resolution is API_VERIFIED');

  // 4c. Raw Fixture Status Mapping Inspection (Audit 1 Provider Verification)
  console.log('\n  [Section 4c: Provider Raw Status Mapping]');
  const mockFixture = (statusShort: string) => ({
    fixture: { id: 9901, status: { short: statusShort } },
    teams: { home: { name: 'TeamA' }, away: { name: 'TeamB' } },
    goals: { home: 2, away: 1 },
  });

  const parsedCanc = parseFixtureEvidence(mockFixture('CANC'));
  assert(parsedCanc?.status === 'CANCELLED', 'Provider CANC maps to internal CANCELLED');

  const parsedPst = parseFixtureEvidence(mockFixture('PST'));
  assert(parsedPst?.status === 'POSTPONED', 'Provider PST maps to internal POSTPONED');

  const parsedAbd = parseFixtureEvidence(mockFixture('ABD'));
  assert(parsedAbd?.status === 'ABANDONED', 'Provider ABD maps to internal ABANDONED');

  const parsedSusp = parseFixtureEvidence(mockFixture('SUSP'));
  assert(parsedSusp?.status === 'SUSPENDED', 'Provider SUSP maps to internal SUSPENDED (not premature settlement)');

  const parsedWo = parseFixtureEvidence(mockFixture('WO'));
  assert(parsedWo?.status === 'WALKOVER', 'Provider WO maps to internal WALKOVER (never auto-voided)');

  const parsedFt = parseFixtureEvidence(mockFixture('FT'));
  assert(parsedFt?.status === 'FINISHED', 'Provider FT maps to internal FINISHED');

  const parsedPen = parseFixtureEvidence(mockFixture('PEN'));
  assert(parsedPen?.status === 'FINISHED', 'Provider PEN maps to internal FINISHED');

  const parsedAet = parseFixtureEvidence(mockFixture('AET'));
  assert(parsedAet?.status === 'FINISHED', 'Provider AET maps to internal FINISHED');

  // 5. Unsupported Market Protection (Never infer player stats from score)
  console.log('\n  [Section 5: Unsupported Market Protection]');
  const playerGoalscorerPick = adjudicateFootballPrediction('FIRST_GOALSCORER', 'Bukayo Saka', ft21Evidence);
  assert(playerGoalscorerPick.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'First Goalscorer market fails safe to UNSUPPORTED_REQUIRES_MANUAL');
  assert(playerGoalscorerPick.verification === 'UNVERIFIED', 'Unsupported market verification is UNVERIFIED');

  const anytimeGoalscorer = adjudicateFootballPrediction('ANYTIME_GOALSCORER', 'Gabriel Martinelli', ft21Evidence);
  assert(anytimeGoalscorer.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'Anytime Goalscorer market fails safe to UNSUPPORTED_REQUIRES_MANUAL');

  const cornerPick = adjudicateFootballPrediction('TOTAL_CORNERS', 'Over 9.5', ft21Evidence);
  assert(cornerPick.outcome === 'UNSUPPORTED_REQUIRES_MANUAL', 'Corners market fails safe to UNSUPPORTED_REQUIRES_MANUAL');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('settlement.test.ts')) {
  const r = runSettlementUnitTests();
  console.log(`\nSettlement Unit Tests: ${r.count - r.failures.length}/${r.count} passed.`);
  process.exit(r.passed ? 0 : 1);
}
