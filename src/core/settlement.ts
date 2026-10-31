/**
 * Automated Football Settlement Engine & Rule Adjudicator
 *
 * Implements:
 * 1. Authoritative API data-driven settlement for confirmed completed matches.
 * 2. Exact market evaluation rules:
 *    - 1X2 (Match Winner / Draw)
 *    - TOTAL_GOALS (Over / Under with decimal or integer lines)
 *    - BTTS (Both Teams To Score: Yes / No)
 * 3. Match status handling:
 *    - FINISHED: Adjudicate decisive outcome
 *    - POSTPONED: Retain PENDING
 *    - ABANDONED: Retain PENDING pending authoritative confirmation
 *    - CANCELLED: Settle as VOID
 * 4. Unsupported markets: Tagged UNSUPPORTED_REQUIRES_MANUAL; never infer player stats from team score.
 * 5. Full audit logging in outcome_events and atomic synchronization to memory_outbox.
 */

import { withTransaction, query } from './db.ts';
import { formatStructuredMemory } from './crypto.ts';
import type { PredictionOutcome, VerificationType } from './predictions.ts';

export interface MatchScoreEvidence {
  apiFixtureId?: number;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  status: 'FINISHED' | 'POSTPONED' | 'CANCELLED' | 'ABANDONED' | 'SUSPENDED' | 'WALKOVER' | 'IN_PLAY';
  statusShort?: string; // FT, AET, PEN, PST, CANC, ABD, SUSP, WO
  settledAt?: string;
}

export interface AdjudicationResult {
  outcome: PredictionOutcome;
  verification: VerificationType;
  reason: string;
  isDecisive: boolean;
}

/**
 * Pure deterministic adjudicator evaluating a market and selection against authoritative match evidence
 */
export function adjudicateFootballPrediction(
  market: string,
  selection: string,
  evidence: MatchScoreEvidence
): AdjudicationResult {
  const normMarket = market.trim().toUpperCase();
  const normSel = selection.trim().toUpperCase();

  // 1. Non-finished / Non-standard status adjudication
  if (evidence.status === 'CANCELLED') {
    return {
      outcome: 'VOID',
      verification: 'API_VERIFIED',
      reason: 'Match cancelled; outcome is void',
      isDecisive: false,
    };
  }

  if (evidence.status === 'WALKOVER') {
    return {
      outcome: 'UNSUPPORTED_REQUIRES_MANUAL',
      verification: 'UNVERIFIED',
      reason: 'Match awarded by walkover (WO); no approved auto-void policy exists, routed to manual review to prevent silent voiding',
      isDecisive: false,
    };
  }

  if (evidence.status === 'SUSPENDED') {
    return {
      outcome: 'PENDING',
      verification: 'UNVERIFIED',
      reason: 'Match is SUSPENDED; must not settle prematurely; awaiting official resumption or competition ruling',
      isDecisive: false,
    };
  }

  if (evidence.status === 'POSTPONED' || evidence.status === 'ABANDONED' || evidence.status === 'IN_PLAY') {
    return {
      outcome: 'PENDING',
      verification: 'UNVERIFIED',
      reason: `Match is currently ${evidence.status}; awaiting final completed match data`,
      isDecisive: false,
    };
  }

  if (evidence.status !== 'FINISHED') {
    return {
      outcome: 'PENDING',
      verification: 'UNVERIFIED',
      reason: `Unknown match status: ${evidence.status}`,
      isDecisive: false,
    };
  }

  const { homeGoals, awayGoals, homeTeam, awayTeam } = evidence;
  const normHome = homeTeam.trim().toUpperCase();
  const normAway = awayTeam.trim().toUpperCase();

  // 2. 1X2 Market Adjudication
  if (normMarket === '1X2' || normMarket === 'MATCH_RESULT') {
    let winningSide: 'HOME' | 'DRAW' | 'AWAY';
    if (homeGoals > awayGoals) winningSide = 'HOME';
    else if (homeGoals < awayGoals) winningSide = 'AWAY';
    else winningSide = 'DRAW';

    const isHomePick = normSel === '1' || normSel === 'HOME' || normSel === normHome || normSel.includes(normHome);
    const isAwayPick = normSel === '2' || normSel === 'AWAY' || normSel === normAway || normSel.includes(normAway);
    const isDrawPick = normSel === 'X' || normSel === 'DRAW';

    if (isDrawPick) {
      return {
        outcome: winningSide === 'DRAW' ? 'WON' : 'LOST',
        verification: 'API_VERIFIED',
        reason: `Draw pick evaluated against full-time score ${homeGoals}-${awayGoals}`,
        isDecisive: true,
      };
    }

    if (isHomePick) {
      return {
        outcome: winningSide === 'HOME' ? 'WON' : 'LOST',
        verification: 'API_VERIFIED',
        reason: `Home pick (${homeTeam}) evaluated against score ${homeGoals}-${awayGoals}`,
        isDecisive: true,
      };
    }

    if (isAwayPick) {
      return {
        outcome: winningSide === 'AWAY' ? 'WON' : 'LOST',
        verification: 'API_VERIFIED',
        reason: `Away pick (${awayTeam}) evaluated against score ${homeGoals}-${awayGoals}`,
        isDecisive: true,
      };
    }

    return {
      outcome: 'UNSUPPORTED_REQUIRES_MANUAL',
      verification: 'UNVERIFIED',
      reason: `Unable to map selection "${selection}" to 1X2 side`,
      isDecisive: false,
    };
  }

  // 3. Both Teams to Score (BTTS)
  if (normMarket === 'BTTS' || normMarket === 'BOTH_TEAMS_TO_SCORE') {
    const bttsOccurred = homeGoals > 0 && awayGoals > 0;
    const isYes = normSel === 'YES' || normSel === 'GG' || normSel === 'GOAL/GOAL';
    const isNo = normSel === 'NO' || normSel === 'NG' || normSel === 'NO GOAL';

    if (isYes) {
      return {
        outcome: bttsOccurred ? 'WON' : 'LOST',
        verification: 'API_VERIFIED',
        reason: `BTTS Yes evaluated against score ${homeGoals}-${awayGoals}`,
        isDecisive: true,
      };
    }

    if (isNo) {
      return {
        outcome: !bttsOccurred ? 'WON' : 'LOST',
        verification: 'API_VERIFIED',
        reason: `BTTS No evaluated against score ${homeGoals}-${awayGoals}`,
        isDecisive: true,
      };
    }

    return {
      outcome: 'UNSUPPORTED_REQUIRES_MANUAL',
      verification: 'UNVERIFIED',
      reason: `Unable to parse BTTS selection "${selection}"`,
      isDecisive: false,
    };
  }

  // 4. Total Goals (Over/Under)
  if (normMarket === 'TOTAL_GOALS' || normMarket === 'OVER_UNDER') {
    // Regex for: Over 2.5, Under 1.5, O 2.5, U 3.5, +2.5, -2.5
    const match = normSel.match(/(OVER|UNDER|O|U|\+|\-)\s*(\d+(\.\d+)?)/);
    if (!match) {
      return {
        outcome: 'UNSUPPORTED_REQUIRES_MANUAL',
        verification: 'UNVERIFIED',
        reason: `Unable to parse Total Goals selection "${selection}"`,
        isDecisive: false,
      };
    }

    const direction = (match[1].startsWith('O') || match[1] === '+') ? 'OVER' : 'UNDER';
    const line = parseFloat(match[2]);
    const totalGoals = homeGoals + awayGoals;

    if (direction === 'OVER') {
      if (totalGoals > line) {
        return {
          outcome: 'WON',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} > line ${line}`,
          isDecisive: true,
        };
      } else if (totalGoals === line) {
        return {
          outcome: 'PUSH',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} === integer line ${line} (Push)`,
          isDecisive: false,
        };
      } else {
        return {
          outcome: 'LOST',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} < line ${line}`,
          isDecisive: true,
        };
      }
    } else { // UNDER
      if (totalGoals < line) {
        return {
          outcome: 'WON',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} < line ${line}`,
          isDecisive: true,
        };
      } else if (totalGoals === line) {
        return {
          outcome: 'PUSH',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} === integer line ${line} (Push)`,
          isDecisive: false,
        };
      } else {
        return {
          outcome: 'LOST',
          verification: 'API_VERIFIED',
          reason: `Total ${totalGoals} > line ${line}`,
          isDecisive: true,
        };
      }
    }
  }

  // 5. Unsupported markets (player props, corners, goalscorers)
  return {
    outcome: 'UNSUPPORTED_REQUIRES_MANUAL',
    verification: 'UNVERIFIED',
    reason: `Market "${market}" is not supported for automatic adjudication; requires manual user settlement. Never infer player stats from score.`,
    isDecisive: false,
  };
}

/**
 * Settles a prediction in the database using match evidence, logging outcome_events and queueing outbox memory
 */
export async function executeAutomatedSettlement(params: {
  userId: string;
  predictionId: string;
  evidence: MatchScoreEvidence;
}): Promise<{ outcome: PredictionOutcome; verification: VerificationType; auditEventId: string }> {
  const { userId, predictionId, evidence } = params;

  return withTransaction(async (client) => {
    // 1. Fetch prediction with lock
    const pRes = await client.query(`
      SELECT p.*, e.label as event_label, e.sport
      FROM predictions p
      JOIN events e ON e.id = p.event_id
      WHERE p.id = $1 AND p.user_id = $2
      FOR UPDATE;
    `, [predictionId, userId]);

    if (pRes.rows.length === 0) {
      throw new Error(`Prediction not found: ${predictionId}`);
    }

    const prediction = pRes.rows[0];

    // Duplicate settlement protection
    if (prediction.outcome !== 'PENDING') {
      throw new Error(`Prediction is already settled as ${prediction.outcome}`);
    }

    // 2. Adjudicate
    const adj = adjudicateFootballPrediction(prediction.market, prediction.selection, evidence);

    // 3. Update prediction
    await client.query(`
      UPDATE predictions
      SET outcome = $1, verification = $2, updated_at = NOW()
      WHERE id = $3;
    `, [adj.outcome, adj.verification, predictionId]);

    // 4. Log outcome event
    const auditRes = await client.query<{ id: string }>(`
      INSERT INTO outcome_events (prediction_id, old_outcome, new_outcome, source, evidence_json)
      VALUES ($1, $2, $3, 'AUTOMATED_API', $4)
      RETURNING id;
    `, [predictionId, 'PENDING', adj.outcome, JSON.stringify({ ...evidence, reason: adj.reason })]);

    // 5. Outbox sequence & memory enqueue
    const seqRes = await client.query<{ next_seq: string }>(`
      SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next_seq
      FROM memory_receipts
      WHERE user_id = $1;
    `, [userId]);
    const nextSeq = parseInt(seqRes.rows[0].next_seq, 10);

    const memoryString = formatStructuredMemory({
      analystId: prediction.analyst_id,
      eventType: 'SETTLED',
      sequenceNumber: nextSeq,
      payload: {
        predictionId,
        outcome: adj.outcome,
        verification: adj.verification,
        score: `${evidence.homeGoals}-${evidence.awayGoals}`,
        status: evidence.status,
        settledAt: new Date().toISOString(),
      },
    });

    const eventKey = `pred-settle-${predictionId}`;
    await client.query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status)
      VALUES ($1, $2, $3, 'PENDING')
      ON CONFLICT (user_id, event_key) DO UPDATE
      SET payload = EXCLUDED.payload, status = 'PENDING', updated_at = NOW();
    `, [userId, eventKey, memoryString]);

    return {
      outcome: adj.outcome,
      verification: adj.verification,
      auditEventId: auditRes.rows[0].id,
    };
  });
}

