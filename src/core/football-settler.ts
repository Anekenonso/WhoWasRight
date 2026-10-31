/**
 * Football Settlement Polling Engine
 *
 * Implements:
 * 1. Cron-authenticated secure endpoint handler.
 * 2. Shared fixture polling: one API call per fixture regardless of how many
 *    predictions reference it.
 * 3. Conservative quota budgeting: halts if fewer than 5 requests remain.
 * 4. Deterministic market adjudication using the existing settlement engine.
 * 5. Atomic settlement: outcome + outcome_event + memory_outbox in one transaction.
 * 6. Idempotent: skips predictions not in PENDING state.
 * 7. Notification queue creation for each settled or unsupported prediction.
 * 8. Provider status and full-time validation before adjudication.
 *
 * No guessing: if the API cannot prove a final result, the prediction stays PENDING.
 */

import { query, withTransaction } from './db.ts';
import { globalFootballRateLimiter, getOrFetchFixture, isWithinFreePlanWindow } from './football-cache.ts';
import { adjudicateFootballPrediction, executeAutomatedSettlement } from './settlement.ts';
import { enqueueNotification } from './telegram-bot.ts';
import type { MatchScoreEvidence } from './settlement.ts';

export interface SettlementRunResult {
  fixturesChecked: number;
  predictionsSettled: number;
  predictionsManual: number;
  predictionsPending: number;
  quotaRemaining: number;
  errors: string[];
}

/**
 * Verifies the CRON_SECRET in the Authorization header.
 * Returns true only if the secret matches exactly.
 */
export function verifyCronSecret(authorizationHeader: string | undefined): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !authorizationHeader) return false;
  const expected = `Bearer ${secret}`;
  if (authorizationHeader.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ authorizationHeader.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Fetches live fixture data from the football API provider (API-Sports format).
 */
async function fetchFixtureFromApi(fixtureId: number): Promise<any> {
  const apiKey = process.env.FOOTBALL_API_KEY;
  const baseUrl = process.env.FOOTBALL_API_BASE_URL ?? 'https://v3.football.api-sports.io';

  if (!apiKey) throw new Error('FOOTBALL_API_KEY not configured');

  const res = await fetch(`${baseUrl}/fixtures?id=${fixtureId}`, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': new URL(baseUrl).hostname,
    },
  });

  if (!res.ok) {
    throw new Error(`Football API HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json() as any;
  if (!data?.response || data.response.length === 0) return null;
  return data.response[0]; // First fixture in response
}

/**
 * Converts API-Sports fixture response to our MatchScoreEvidence format.
 * Returns null if the match is not in a settled terminal state.
 */
export function parseFixtureEvidence(fixtureData: any): MatchScoreEvidence | null {
  if (!fixtureData?.fixture) return null;

  const statusShort = fixtureData.fixture.status?.short ?? 'UNKNOWN';
  const goals = fixtureData.goals;
  const teams = fixtureData.teams;

  // Map API-Sports status codes to our internal states
  let status: MatchScoreEvidence['status'];
  if (['FT', 'AET', 'PEN'].includes(statusShort)) {
    status = 'FINISHED';
  } else if (statusShort === 'PST') {
    status = 'POSTPONED';
  } else if (statusShort === 'CANC') {
    status = 'CANCELLED';
  } else if (statusShort === 'WO') {
    status = 'WALKOVER';
  } else if (statusShort === 'SUSP') {
    status = 'SUSPENDED';
  } else if (['ABD', 'INT'].includes(statusShort)) {
    status = 'ABANDONED';
  } else if (['1H', '2H', 'HT', 'ET', 'BT', 'P', 'LIVE'].includes(statusShort)) {
    status = 'IN_PLAY';
  } else {
    // NS (not started), TBD, or unknown — remain pending
    return null;
  }

  // For FINISHED matches, both goal counts must be present
  if (status === 'FINISHED' && (goals?.home == null || goals?.away == null)) {
    return null; // Incomplete data — do not settle
  }

  return {
    apiFixtureId: fixtureData.fixture.id,
    homeTeam: teams?.home?.name ?? 'Home',
    awayTeam: teams?.away?.name ?? 'Away',
    homeGoals: status === 'FINISHED' ? Number(goals.home) : 0,
    awayGoals: status === 'FINISHED' ? Number(goals.away) : 0,
    status,
    statusShort,
    settledAt: new Date().toISOString(),
  };
}

/**
 * Main settlement run. Called by the authenticated cron endpoint.
 * Processes all PENDING football predictions, grouped by fixture to share API quota.
 */
export async function runSettlementCycle(): Promise<SettlementRunResult> {
  const result: SettlementRunResult = {
    fixturesChecked: 0,
    predictionsSettled: 0,
    predictionsManual: 0,
    predictionsPending: 0,
    quotaRemaining: globalFootballRateLimiter.getUsage().remaining,
    errors: [],
  };

  // 1. Find all distinct fixtures for PENDING football predictions
  const fixtureRes = await query<{
    api_fixture_id: string;
    kickoff_utc: string;
  }>(
    `SELECT DISTINCT e.api_fixture_id, e.start_at_utc as kickoff_utc
     FROM predictions p
     JOIN events e ON e.id = p.event_id
     WHERE p.outcome = 'PENDING'
       AND e.sport = 'FOOTBALL'
       AND e.api_fixture_id IS NOT NULL
       AND e.status NOT IN ('CANCELLED', 'VOID')
     ORDER BY e.start_at_utc ASC;`
  );

  for (const row of fixtureRes.rows) {
    const fixtureId = Number(row.api_fixture_id);
    const kickoff = new Date(row.kickoff_utc);

    // 2. Check quota before each fixture fetch
    if (!globalFootballRateLimiter.canMakeRequest()) {
      result.errors.push(`Quota exhausted before fixture ${fixtureId}`);
      break;
    }

    // 3. Check free plan date window
    if (!isWithinFreePlanWindow(kickoff)) {
      result.predictionsPending++;
      continue;
    }

    result.fixturesChecked++;

    try {
      // 4. Fetch fixture (from cache or live API)
      const { fixture, fromCache, rateLimited } = await getOrFetchFixture(fixtureId, fetchFixtureFromApi);

      if (rateLimited) {
        result.errors.push(`Rate limited fetching fixture ${fixtureId}`);
        break;
      }

      if (!fixture) {
        result.predictionsPending++;
        continue;
      }

      // 5. Parse evidence
      const evidence = parseFixtureEvidence(fixture);
      if (!evidence) {
        result.predictionsPending++;
        continue;
      }

      // 6. Fetch all PENDING predictions for this fixture
      const predRes = await query<{
        id: string;
        user_id: string;
        market: string;
        selection: string;
        analyst_id: string;
        event_label: string;
        analyst_name: string;
      }>(
        `SELECT p.id, p.user_id, p.market, p.selection, p.analyst_id,
                e.label as event_label, a.name as analyst_name
         FROM predictions p
         JOIN events e ON e.id = p.event_id
         JOIN analysts a ON a.id = p.analyst_id
         WHERE e.api_fixture_id = $1
           AND p.outcome = 'PENDING'
           AND e.sport = 'FOOTBALL';`,
        [fixtureId]
      );

      for (const pred of predRes.rows) {
        // 7. Adjudicate (pure, deterministic)
        const adj = adjudicateFootballPrediction(pred.market, pred.selection, evidence);

        if (adj.outcome === 'PENDING') {
          result.predictionsPending++;
          continue;
        }

        const viewUrl = `/predictions/${pred.id}`;
        const appBase = process.env.APP_BASE_URL ?? '';

        if (adj.outcome === 'UNSUPPORTED_REQUIRES_MANUAL') {
          // 8a. Queue manual settlement prompt
          result.predictionsManual++;
          try {
            await enqueueNotification({
              userId: pred.user_id,
              predictionId: pred.id,
              notificationType: 'SETTLEMENT_MANUAL',
              payload: {
                eventName: pred.event_label,
                analystName: pred.analyst_name,
                market: pred.market,
                selection: pred.selection,
                viewUrl,
              },
            });
          } catch (notifErr) {
            result.errors.push(`Notification error for prediction ${pred.id}: ${(notifErr as Error).message}`);
          }
          continue;
        }

        // 8b. Execute atomic settlement
        try {
          await executeAutomatedSettlement({
            userId: pred.user_id,
            predictionId: pred.id,
            evidence,
          });
          result.predictionsSettled++;

          // 9. Queue settlement notification (non-blocking — settlement already committed)
          try {
            await enqueueNotification({
              userId: pred.user_id,
              predictionId: pred.id,
              notificationType: 'SETTLEMENT_AUTO',
              payload: {
                eventName: pred.event_label,
                analystName: pred.analyst_name,
                market: pred.market,
                selection: pred.selection,
                outcome: adj.outcome,
                score: `${evidence.homeGoals}-${evidence.awayGoals}`,
                reason: adj.reason,
                viewUrl,
              },
            });
          } catch (notifErr) {
            // Failed notification MUST NOT roll back settlement
            result.errors.push(`Post-settlement notification error for ${pred.id}: ${(notifErr as Error).message}`);
          }
        } catch (settlementErr: unknown) {
          const msg = (settlementErr as Error).message;
          if (msg.includes('already settled')) {
            // Idempotent — skip silently
          } else {
            result.errors.push(`Settlement error for prediction ${pred.id}: ${msg}`);
            result.predictionsPending++;
          }
        }
      }

      if (!fromCache) {
        result.quotaRemaining = globalFootballRateLimiter.getUsage().remaining;
      }
    } catch (err: unknown) {
      result.errors.push(`Fixture ${fixtureId} error: ${(err as Error).message}`);
    }
  }

  return result;
}

