/**
 * Walrus Historical Reconstruction Contract
 *
 * Implements:
 * 1. Independent reconstruction of credibility history purely from validated Walrus Memory events.
 * 2. Sequence-ordered deterministic event replay (CREATED -> SETTLED -> CORRECTED).
 * 3. Global user-level sequence integrity checking (fails closed if gap or auth tag mismatch).
 * 4. Analyst projection and verification against PostgreSQL operational state.
 */

import { parseStructuredMemory, decryptRecord, type EncryptedPayload } from './crypto.ts';
import { computeCredibility, type CredibilityScorecard } from './credibility.ts';

export interface ReconstructedEvent {
  sequenceNumber: number;
  analystId: string;
  eventType: 'CREATED' | 'SETTLED' | 'CORRECTED' | 'ANALYST_MERGED' | 'SNAPSHOT';
  payload: any;
  rawMemoryString: string;
}

export interface ReplayPredictionState {
  predictionId: string;
  analystId: string;
  market: string;
  selection: string;
  outcome: string;
  verification: string;
  createdAt: string;
  settledAt?: string;
  correctedAt?: string;
}

export interface ReconstructionReport {
  success: boolean;
  totalEventsProcessed: number;
  validEventsCount: number;
  tamperedEventsCount: number;
  sequenceGapsDetected: number[];
  reconstructedPredictions: Record<string, ReplayPredictionState>;
  credibility: CredibilityScorecard;
  error?: string;
}

/**
 * Reconstructs analyst predictions and credibility scorecard from an array of raw Walrus memory strings
 */
export function reconstructFromWalrusMemories(
  rawMemories: string[],
  targetAnalystId?: string,
  encryptionKey?: Buffer
): ReconstructionReport {
  const allParsedEvents: ReconstructedEvent[] = [];
  let tamperedCount = 0;

  // 1. Parse and Decrypt each memory string across the user's entire sequence
  for (const mem of rawMemories) {
    const parsed = parseStructuredMemory(mem);
    if (!parsed) {
      tamperedCount++;
      continue;
    }

    try {
      const decrypted = decryptRecord<any>(parsed.encryptedPayload, encryptionKey, parsed.keyVersion);
      allParsedEvents.push({
        sequenceNumber: parsed.sequenceNumber,
        analystId: parsed.analystId,
        eventType: parsed.eventType as any,
        payload: decrypted,
        rawMemoryString: mem,
      });
    } catch {
      // AES-GCM Auth tag rejected or wrong key
      tamperedCount++;
    }
  }

  // 2. Sort ALL parsed events strictly by global sequenceNumber
  allParsedEvents.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  // 3. Global Sequence Continuity Check (across all events belonging to user BEFORE analyst filtering)
  const sequenceGaps: number[] = [];
  for (let i = 0; i < allParsedEvents.length; i++) {
    const expected = i + 1;
    if (allParsedEvents[i].sequenceNumber !== expected) {
      sequenceGaps.push(expected);
    }
  }

  // 4. Project/Filter to targetAnalystId (if specified)
  const targetEvents = targetAnalystId
    ? allParsedEvents.filter(ev => ev.analystId === targetAnalystId)
    : allParsedEvents;

  // 5. Deterministic State Machine Replay for target analyst
  const predictions: Record<string, ReplayPredictionState> = {};

  for (const ev of targetEvents) {
    const p = ev.payload;
    if (ev.eventType === 'CREATED') {
      predictions[p.predictionId] = {
        predictionId: p.predictionId,
        analystId: ev.analystId,
        market: p.market,
        selection: p.selection,
        outcome: 'PENDING',
        verification: 'UNVERIFIED',
        createdAt: p.createdAt,
      };
    } else if (ev.eventType === 'SETTLED') {
      if (predictions[p.predictionId]) {
        predictions[p.predictionId].outcome = p.outcome || p.newOutcome || 'PENDING';
        predictions[p.predictionId].verification = p.verification || 'UNVERIFIED';
        predictions[p.predictionId].settledAt = p.settledAt;
      }
    } else if (ev.eventType === 'CORRECTED') {
      if (predictions[p.predictionId]) {
        predictions[p.predictionId].outcome = p.outcome || p.newOutcome || 'PENDING';
        predictions[p.predictionId].verification = p.verification || 'UNVERIFIED';
        predictions[p.predictionId].correctedAt = p.settledAt || p.correctedAt;
      }
    } else if (ev.eventType === 'SNAPSHOT') {
      if (p.predictions && Array.isArray(p.predictions)) {
        for (const snapPred of p.predictions) {
          predictions[snapPred.predictionId] = {
            predictionId: snapPred.predictionId,
            analystId: ev.analystId,
            market: snapPred.market,
            selection: snapPred.selection,
            outcome: snapPred.outcome || 'PENDING',
            verification: snapPred.verification || 'UNVERIFIED',
            createdAt: snapPred.createdAt || p.timestamp,
          };
        }
      }
    }
  }

  // 6. Compute Credibility from Reconstructed State
  const outcomeItems = Object.values(predictions).map(p => ({
    outcome: p.outcome,
    verification: p.verification,
  }));

  const credibility = computeCredibility(outcomeItems, targetAnalystId);

  const success = tamperedCount === 0 && sequenceGaps.length === 0;

  return {
    success,
    totalEventsProcessed: rawMemories.length,
    validEventsCount: targetEvents.length,
    tamperedEventsCount: tamperedCount,
    sequenceGapsDetected: sequenceGaps,
    reconstructedPredictions: predictions,
    credibility,
    error: !success ? `Reconstruction failed integrity check: ${tamperedCount} tampered, ${sequenceGaps.length} gaps` : undefined,
  };
}
