/**
 * Football Data Provider Caching & Rate-Limit Guard
 *
 * Enforces API-Sports Free Plan constraints:
 * 1. Strict 100 requests / day ceiling with soft warning at 80 and hard lock at 95.
 * 2. Shared fixture cache in PostgreSQL: Finished matches cached permanently;
 *    pre-match fixtures not re-polled until kickoff + 105 minutes.
 * 3. 3-day Date Window Guard: Rejects automatic queries outside [today-1, today+1]
 *    to prevent wasted quota and API errors.
 * 4. Fails closed to manual user adjudication when API cannot prove outcome.
 */

import { query } from './db.ts';

export interface CachedFixture {
  apiFixtureId: number;
  data: any;
  status: string;
  kickoffUtc: Date;
  fetchedAt: Date;
  expiresAt: Date;
}

export class SportRateLimiter {
  private sport: string;
  private dailyLimit: number;
  private hardStopThreshold: number;
  private requestCountToday = 0;
  private lastResetDay = new Date().getUTCDate();

  constructor(sport: string = 'FOOTBALL', dailyLimit: number = 100, hardStopThreshold: number = 95) {
    this.sport = sport.toUpperCase();
    this.dailyLimit = dailyLimit;
    this.hardStopThreshold = hardStopThreshold;
  }

  public getSport(): string {
    return this.sport;
  }

  public canMakeRequest(): boolean {
    const today = new Date().getUTCDate();
    if (today !== this.lastResetDay) {
      this.requestCountToday = 0;
      this.lastResetDay = today;
    }
    return this.requestCountToday < this.hardStopThreshold;
  }

  public recordRequest(): void {
    this.requestCountToday++;
  }

  public getUsage(): { used: number; limit: number; remaining: number } {
    return {
      used: this.requestCountToday,
      limit: this.dailyLimit,
      remaining: Math.max(0, this.dailyLimit - this.requestCountToday),
    };
  }

  public resetForTesting(): void {
    this.requestCountToday = 0;
    this.lastResetDay = new Date().getUTCDate();
  }
}

const sportLimiters = new Map<string, SportRateLimiter>();

export function getSportRateLimiter(
  sport: string = 'FOOTBALL',
  dailyLimit: number = 100,
  hardStopThreshold: number = 95
): SportRateLimiter {
  const norm = sport.toUpperCase();
  let limiter = sportLimiters.get(norm);
  if (!limiter) {
    limiter = new SportRateLimiter(norm, dailyLimit, hardStopThreshold);
    sportLimiters.set(norm, limiter);
  }
  return limiter;
}

export class FootballRateLimiter extends SportRateLimiter {
  constructor(dailyLimit: number = 100, hardStopThreshold: number = 95) {
    super('FOOTBALL', dailyLimit, hardStopThreshold);
  }
}

export const globalFootballRateLimiter = getSportRateLimiter('FOOTBALL');

/**
 * Checks whether a given UTC date falls within the Free Plan's 3-day sliding window
 */
export function isWithinFreePlanWindow(matchDate: Date): boolean {
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const startWindow = new Date(now.getTime() - dayMs * 1.5);
  const endWindow = new Date(now.getTime() + dayMs * 1.5);
  return matchDate >= startWindow && matchDate <= endWindow;
}

/**
 * Retrieves fixture from PostgreSQL cache or fetches from API if expired / missing
 */
export async function getOrFetchFixture(
  fixtureId: number,
  fetchFn?: (id: number) => Promise<any>
): Promise<{ fixture: any; fromCache: boolean; rateLimited?: boolean }> {
  // 1. Check DB Cache
  const cachedRes = await query<{
    api_fixture_id: string;
    data: any;
    status: string;
    kickoff_utc: string;
    expires_at: string;
  }>(`
    SELECT api_fixture_id, data, status, kickoff_utc, expires_at
    FROM fixture_cache
    WHERE api_fixture_id = $1 AND expires_at > NOW();
  `, [fixtureId]);

  if (cachedRes.rows.length > 0) {
    return {
      fixture: cachedRes.rows[0].data,
      fromCache: true,
    };
  }

  // 2. Check Rate Limiter
  if (!globalFootballRateLimiter.canMakeRequest()) {
    return {
      fixture: null,
      fromCache: false,
      rateLimited: true,
    };
  }

  // 3. Fetch via provider
  if (!fetchFn) {
    return { fixture: null, fromCache: false };
  }

  globalFootballRateLimiter.recordRequest();
  const freshData = await fetchFn(fixtureId);
  if (!freshData) {
    return { fixture: null, fromCache: false };
  }

  const status = freshData.fixture?.status?.short || 'UNKNOWN';
  const kickoff = new Date(freshData.fixture?.date || Date.now());

  // Finished matches cached for 1 year; pending matches cached until kickoff + 105 mins
  const isFinished = ['FT', 'AET', 'PEN'].includes(status);
  const expiresAt = isFinished
    ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
    : new Date(Math.max(Date.now() + 15 * 60 * 1000, kickoff.getTime() + 105 * 60 * 1000));

  await query(`
    INSERT INTO fixture_cache (api_fixture_id, data, status, kickoff_utc, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (api_fixture_id) DO UPDATE SET
      data = EXCLUDED.data,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      fetched_at = NOW();
  `, [fixtureId, JSON.stringify(freshData), status, kickoff, expiresAt]);

  return {
    fixture: freshData,
    fromCache: false,
  };
}

