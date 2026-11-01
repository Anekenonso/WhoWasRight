/**
 * Core Prediction Domain Logic & State Management
 *
 * Enforces:
 * 1. Strict Kickoff Locking (fails closed at or after start_at_utc or when ever_started=true).
 * 2. Exact Duplicate Prevention per (user_id, event_id, analyst_id, market, selection).
 * 3. Multi-Pick Allowance: Analyst can log multiple distinct markets/selections for one match.
 * 4. Outcome State Machine: Valid transitions and audit logging into outcome_events.
 * 5. Transactional Outbox Pattern: Invariant database state + Walrus outbox in one commit.
 */

import { query, withTransaction } from './db.ts';
import { formatStructuredMemory } from './crypto.ts';
import { allocateNextEventSequence } from './sequence-allocator.ts';

export type PredictionOutcome = 'PENDING' | 'WON' | 'LOST' | 'PUSH' | 'VOID' | 'UNSUPPORTED_REQUIRES_MANUAL';
export type VerificationType = 'API_VERIFIED' | 'SELF_REPORTED' | 'UNVERIFIED';

export interface CreateEventParams {
  userId: string;
  sport?: string;
  label: string;
  startAtUtc: Date;
  apiFixtureId?: number;
  source: 'API_SPORTS' | 'USER_REPORTED' | 'SYNTHETIC_SAMPLE';
}

export interface CreatePredictionParams {
  userId: string;
  eventId: string;
  analystId: string;
  market: string;
  selection: string;
  rawText?: string;
}

export interface SettlePredictionParams {
  userId: string;
  predictionId: string;
  newOutcome: PredictionOutcome;
  source: 'AUTOMATED_API' | 'MANUAL_USER' | 'CORRECTION';
  evidenceJson?: Record<string, unknown>;
  verification: VerificationType;
}

export interface PredictionRecord {
  id: string;
  user_id: string;
  event_id: string;
  analyst_id: string;
  market: string;
  selection: string;
  raw_text?: string;
  created_at_utc: string;
  outcome: PredictionOutcome;
  verification: VerificationType;
  archived_at?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Creates an event / match record with UTC start time
 */
export async function createEvent(params: CreateEventParams): Promise<{ id: string }> {
  const sport = params.sport || 'FOOTBALL';
  const res = await query<{ id: string }>(`
    INSERT INTO events (user_id, sport, label, api_fixture_id, start_at_utc, source)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id;
  `, [params.userId, sport, params.label, params.apiFixtureId || null, params.startAtUtc, params.source]);
  return res.rows[0];
}

/**
 * Creates a prediction with strict kickoff lock, duplicate guard, and outbox event
 */
export async function createPrediction(params: CreatePredictionParams): Promise<PredictionRecord> {
  const normMarket = params.market.trim().toUpperCase();
  const normSelection = params.selection.trim();

  return withTransaction(async (client) => {
    // 1. Fetch Event & Verify Kickoff Lock
    const eventRes = await client.query(`
      SELECT id, user_id, start_at_utc, status, ever_started
      FROM events
      WHERE id = $1;
    `, [params.eventId]);

    if (eventRes.rows.length === 0) {
      throw new Error(`Event not found: ${params.eventId}`);
    }

    const event = eventRes.rows[0];
    if (event.user_id !== params.userId) {
      throw new Error('Unauthorized: event belongs to different user');
    }

    const now = new Date();
    const kickoff = new Date(event.start_at_utc);

    // Strict Lock: reject if now >= kickoff or if match ever started/finished
    if (now >= kickoff) {
      throw new Error(`Kickoff locked: match started at ${kickoff.toISOString()} (current time ${now.toISOString()})`);
    }
    if (event.ever_started || ['IN_PLAY', 'FINISHED', 'POSTPONED', 'CANCELLED', 'ABANDONED'].includes(event.status)) {
      throw new Error(`Kickoff locked: event status is ${event.status}`);
    }

    // 2. Verify Analyst Ownership
    const analystRes = await client.query(`
      SELECT id, user_id FROM analysts WHERE id = $1;
    `, [params.analystId]);

    if (analystRes.rows.length === 0 || analystRes.rows[0].user_id !== params.userId) {
      throw new Error('Unauthorized or invalid analyst ID');
    }

    // 3. Exact Duplicate Guard
    const dupRes = await client.query(`
      SELECT id FROM predictions
      WHERE user_id = $1 AND event_id = $2 AND analyst_id = $3 AND market = $4 AND selection = $5;
    `, [params.userId, params.eventId, params.analystId, normMarket, normSelection]);

    if (dupRes.rows.length > 0) {
      throw new Error(`Duplicate prediction: this analyst already has "${normSelection}" for market "${normMarket}" on this match`);
    }

    // 4. Insert Prediction
    const predRes = await client.query<PredictionRecord>(`
      INSERT INTO predictions (user_id, event_id, analyst_id, market, selection, raw_text, outcome, verification)
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'UNVERIFIED')
      RETURNING *;
    `, [params.userId, params.eventId, params.analystId, normMarket, normSelection, params.rawText || null]);

    const prediction = predRes.rows[0];

    // 5. Transaction-safe V2 sequence number allocation for outbox
    const nextSeq = await allocateNextEventSequence(client, params.userId);

    // 6. Format Structured Memory Envelope
    const memoryString = formatStructuredMemory({
      analystId: params.analystId,
      eventType: 'CREATED',
      sequenceNumber: nextSeq,
      payload: {
        predictionId: prediction.id,
        eventId: params.eventId,
        market: normMarket,
        selection: normSelection,
        createdAt: prediction.created_at_utc,
      },
    });

    // 7. Insert Transactional Outbox Record (V2 format with positive sequence number)
    const eventKey = `pred-create-${prediction.id}`;
    await client.query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, $2, $3, 'PENDING', 2, $4);
    `, [params.userId, eventKey, memoryString, nextSeq]);

    return prediction;
  });
}

/**
 * Settles a prediction with valid outcome transitions, audit events, and outbox memory
 */
export async function settlePrediction(params: SettlePredictionParams): Promise<PredictionRecord> {
  const validOutcomes: PredictionOutcome[] = ['WON', 'LOST', 'PUSH', 'VOID', 'UNSUPPORTED_REQUIRES_MANUAL'];
  if (!validOutcomes.includes(params.newOutcome)) {
    throw new Error(`Invalid settlement outcome: ${params.newOutcome}`);
  }

  return withTransaction(async (client) => {
    // 1. Fetch current prediction with row lock
    const pRes = await client.query<PredictionRecord>(`
      SELECT * FROM predictions
      WHERE id = $1 AND user_id = $2
      FOR UPDATE;
    `, [params.predictionId, params.userId]);

    if (pRes.rows.length === 0) {
      throw new Error(`Prediction not found or unauthorized: ${params.predictionId}`);
    }

    const current = pRes.rows[0];
    const oldOutcome = current.outcome;

    // Check transition rules
    if (oldOutcome !== 'PENDING' && params.source !== 'CORRECTION') {
      throw new Error(`Cannot settle already resolved prediction (${oldOutcome}) without explicit CORRECTION source`);
    }

    // 2. Update prediction
    const updRes = await client.query<PredictionRecord>(`
      UPDATE predictions
      SET outcome = $1, verification = $2, updated_at = NOW()
      WHERE id = $3
      RETURNING *;
    `, [params.newOutcome, params.verification, params.predictionId]);

    const updated = updRes.rows[0];

    // 3. Log Audit Event in outcome_events
    await client.query(`
      INSERT INTO outcome_events (prediction_id, old_outcome, new_outcome, source, evidence_json)
      VALUES ($1, $2, $3, $4, $5);
    `, [params.predictionId, oldOutcome, params.newOutcome, params.source, JSON.stringify(params.evidenceJson || {})]);

    // 4. Transaction-safe V2 sequence number allocation for outbox
    const nextSeq = await allocateNextEventSequence(client, params.userId);

    // 5. Format Structured Memory Envelope for Settlement
    const memoryString = formatStructuredMemory({
      analystId: current.analyst_id,
      eventType: params.source === 'CORRECTION' ? 'CORRECTED' : 'SETTLED',
      sequenceNumber: nextSeq,
      payload: {
        predictionId: current.id,
        eventId: current.event_id,
        market: current.market,
        selection: current.selection,
        oldOutcome,
        newOutcome: params.newOutcome,
        verification: params.verification,
        source: params.source,
        settledAt: new Date().toISOString(),
      },
    });

    // 6. Append to Outbox (V2 format with positive sequence number)
    const eventKey = `pred-settle-${current.id}-${Date.now()}`;
    await client.query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status, format_version, sequence_number)
      VALUES ($1, $2, $3, 'PENDING', 2, $4);
    `, [params.userId, eventKey, memoryString, nextSeq]);

    return updated;
  });
}

/**
 * List predictions for a user with joined event and analyst metadata.
 */
export async function getPredictionsForUser(
  userId: string,
  filter: 'ALL' | 'PENDING' | 'SETTLED' | string = 'ALL'
): Promise<any[]> {
  let statusCondition = '';
  if (filter === 'PENDING') {
    statusCondition = "AND p.outcome = 'PENDING'";
  } else if (filter === 'SETTLED') {
    statusCondition = "AND p.outcome != 'PENDING'";
  }

  const res = await query(`
    SELECT
      p.id,
      p.user_id,
      p.event_id,
      p.analyst_id,
      COALESCE(a.name, 'Unknown Analyst') AS analyst_name,
      COALESCE(e.sport, 'Other') AS sport,
      e.label AS event_label,
      e.start_at_utc,
      p.market,
      p.selection,
      p.outcome,
      p.verification,
      p.created_at,
      CASE
        WHEN r.job_id IS NOT NULL THEN 'CONFIRMED'
        WHEN o.status = 'CONFIRMED' THEN 'CONFIRMED'
        WHEN o.status = 'FAILED' THEN 'FAILED'
        ELSE 'PENDING'
      END AS walrus_sync_status
    FROM predictions p
    JOIN events e ON e.id = p.event_id
    LEFT JOIN analysts a ON a.id = p.analyst_id
    LEFT JOIN memory_outbox o ON o.user_id = p.user_id AND o.event_key = 'pred-create-' || p.id::text
    LEFT JOIN memory_receipts r ON r.user_id = p.user_id AND r.job_id = o.walrus_job_id
    WHERE p.user_id = $1
      AND p.archived_at IS NULL
      ${statusCondition}
    ORDER BY p.created_at DESC
  `, [userId]);

  return res.rows;
}

