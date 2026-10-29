/**
 * Deterministic Credibility Calculation Engine
 *
 * Implements:
 * 1. Rating Eligibility: >=6 settled outcomes (Won, Lost, Push) AND >=1 decisive outcome (Won, Lost).
 * 2. Win Rate Math: Won / (Won + Lost). Push counts toward eligibility, NOT denominator.
 * 3. Rating Tiers: Good >= 65%, Average >= 45% and < 65%, Poor < 45%, otherwise 'Not Rated'.
 * 4. History Badges: 0-5 Insufficient, 6-19 Limited, 20-49 Growing, 50+ Established.
 * 5. Distinct reporting of API-verified vs Self-reported outcomes.
 * 6. Individual counting of multiple picks from a single match.
 */

export type RatingTier = 'Good' | 'Average' | 'Poor' | 'Not Rated';
export type HistoryBadge = 'Insufficient' | 'Limited' | 'Growing' | 'Established';

export interface RawOutcomeItem {
  outcome: 'WON' | 'LOST' | 'PUSH' | 'VOID' | 'PENDING' | string;
  verification?: 'API_VERIFIED' | 'SELF_REPORTED' | 'UNVERIFIED' | string;
}

export interface CredibilityScorecard {
  analystId?: string;
  totalPredictions: number;
  pendingCount: number;
  voidCount: number;
  settledCount: number;      // Won + Lost + Push
  decisiveCount: number;     // Won + Lost
  wonCount: number;
  lostCount: number;
  pushCount: number;
  apiVerifiedCount: number;
  selfReportedCount: number;
  isEligible: boolean;
  winRate: number | null;     // percentage 0 - 100 or null if Not Rated
  winRateRatio: number | null; // 0.0 - 1.0 or null
  ratingTier: RatingTier;
  historyBadge: HistoryBadge;
}

export function computeCredibility(outcomes: RawOutcomeItem[], analystId?: string): CredibilityScorecard {
  let pendingCount = 0;
  let voidCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let pushCount = 0;
  let apiVerifiedCount = 0;
  let selfReportedCount = 0;

  for (const item of outcomes) {
    const out = item.outcome.toUpperCase();
    const ver = (item.verification || '').toUpperCase();

    if (out === 'PENDING') {
      pendingCount++;
      continue;
    }
    if (out === 'VOID') {
      voidCount++;
      continue;
    }

    if (ver === 'API_VERIFIED') {
      apiVerifiedCount++;
    } else if (ver === 'SELF_REPORTED') {
      selfReportedCount++;
    }

    if (out === 'WON') {
      wonCount++;
    } else if (out === 'LOST') {
      lostCount++;
    } else if (out === 'PUSH') {
      pushCount++;
    }
  }

  const settledCount = wonCount + lostCount + pushCount;
  const decisiveCount = wonCount + lostCount;
  const isEligible = settledCount >= 6 && decisiveCount >= 1;

  let winRate: number | null = null;
  let winRateRatio: number | null = null;
  let ratingTier: RatingTier = 'Not Rated';

  if (isEligible && decisiveCount > 0) {
    winRateRatio = wonCount / decisiveCount;
    winRate = Math.round(winRateRatio * 10000) / 100; // e.g. 65.00

    if (winRateRatio >= 0.65) {
      ratingTier = 'Good';
    } else if (winRateRatio >= 0.45) {
      ratingTier = 'Average';
    } else {
      ratingTier = 'Poor';
    }
  }

  // History Badge
  let historyBadge: HistoryBadge = 'Insufficient';
  if (settledCount >= 50) {
    historyBadge = 'Established';
  } else if (settledCount >= 20) {
    historyBadge = 'Growing';
  } else if (settledCount >= 6) {
    historyBadge = 'Limited';
  }

  return {
    analystId,
    totalPredictions: outcomes.length,
    pendingCount,
    voidCount,
    settledCount,
    decisiveCount,
    wonCount,
    lostCount,
    pushCount,
    apiVerifiedCount,
    selfReportedCount,
    isEligible,
    winRate,
    winRateRatio,
    ratingTier,
    historyBadge,
  };
}

