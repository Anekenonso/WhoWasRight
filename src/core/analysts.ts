/**
 * Analyst Management & Profile Merging Service
 *
 * Implements:
 * 1. Analyst CRUD (Create, Rename, List, Detail).
 * 2. Multi-platform social handles/aliases (add, remove).
 * 3. Reversible analyst merges:
 *    - Analyst B merged into Analyst A redirects queries without mutating prediction records.
 *    - Reversing the merge restores Analyst B's profile and picks cleanly with 0 data loss.
 * 4. Strict User Ownership on all operations.
 */

import { query, withTransaction } from './db.ts';
import { formatStructuredMemory } from './crypto.ts';
import { computeCredibility, type CredibilityScorecard } from './credibility.ts';
import { reconstructUserHistoryFromWalrus } from './walrus-outbox-worker.ts';

export interface AnalystAlias {
  id: string;
  analyst_id: string;
  platform: 'TELEGRAM' | 'TWITTER' | 'YOUTUBE' | 'TIKTOK' | 'OTHER';
  handle: string;
  created_at: string;
}

export type IntegrityState = 'VERIFIED' | 'NOT_APPLICABLE' | 'INCOMPLETE' | 'UNAVAILABLE' | 'FAILED';

export interface AnalystIntegrityStatus {
  verified: boolean;
  status: IntegrityState;
  warning?: string;
  gaps: number[];
  tampered: number;
}

export interface AnalystRecord {
  id: string;
  user_id: string;
  name: string;
  merged_into_id?: string | null;
  created_at: string;
  updated_at: string;
  aliases?: AnalystAlias[];
  credibility?: CredibilityScorecard;
  mergedAnalysts?: AnalystRecord[];
  predictions?: any[];
  integrity?: AnalystIntegrityStatus;
}

/**
 * Creates a new private analyst profile for the user
 */
export async function createAnalyst(userId: string, name: string): Promise<AnalystRecord> {
  const cleanName = name.trim();
  if (!cleanName) {
    throw new Error('Analyst name cannot be empty');
  }

  const res = await query<AnalystRecord>(`
    INSERT INTO analysts (user_id, name)
    VALUES ($1, $2)
    RETURNING id, user_id, name, merged_into_id, created_at, updated_at;
  `, [userId, cleanName]);

  return {
    ...res.rows[0],
    aliases: [],
  };
}

/**
 * Updates an analyst's name
 */
export async function updateAnalyst(userId: string, analystId: string, newName: string): Promise<AnalystRecord> {
  const cleanName = newName.trim();
  if (!cleanName) {
    throw new Error('Analyst name cannot be empty');
  }

  const res = await query<AnalystRecord>(`
    UPDATE analysts
    SET name = $1, updated_at = NOW()
    WHERE id = $2 AND user_id = $3
    RETURNING id, user_id, name, merged_into_id, created_at, updated_at;
  `, [cleanName, analystId, userId]);

  if (res.rows.length === 0) {
    throw new Error(`Analyst not found or unauthorized: ${analystId}`);
  }

  return res.rows[0];
}

/**
 * Adds a social handle alias to an analyst
 */
export async function addAnalystAlias(
  userId: string,
  analystId: string,
  platform: 'TELEGRAM' | 'TWITTER' | 'YOUTUBE' | 'TIKTOK' | 'OTHER',
  handle: string
): Promise<AnalystAlias> {
  const cleanHandle = handle.trim();
  if (!cleanHandle) {
    throw new Error('Handle cannot be empty');
  }

  // Verify ownership
  const aRes = await query('SELECT id FROM analysts WHERE id = $1 AND user_id = $2;', [analystId, userId]);
  if (aRes.rows.length === 0) {
    throw new Error(`Analyst not found or unauthorized: ${analystId}`);
  }

  const res = await query<AnalystAlias>(`
    INSERT INTO analyst_aliases (analyst_id, platform, handle)
    VALUES ($1, $2, $3)
    RETURNING id, analyst_id, platform, handle, created_at;
  `, [analystId, platform, cleanHandle]);

  return res.rows[0];
}

/**
 * Removes a social handle alias
 */
export async function removeAnalystAlias(userId: string, aliasId: string): Promise<boolean> {
  const res = await query(`
    DELETE FROM analyst_aliases
    WHERE id = $1
      AND analyst_id IN (SELECT id FROM analysts WHERE user_id = $2);
  `, [aliasId, userId]);

  return (res.rowCount ?? 0) > 0;
}

/**
 * Reversibly merges sourceAnalyst into targetAnalyst
 *
 * Enforces strict safety rules:
 * 1. An analyst cannot be merged into themselves (prevents self-cycles).
 * 2. Cross-user isolation: Both source and target must belong to userId.
 * 3. Cannot merge an analyst that is already merged (prevents merge chains).
 * 4. Cannot merge into an analyst that is already merged (target must be an unmerged root).
 * 5. Cannot create cycles (target cannot have been merged from source).
 * 6. Supports arbitrary siblings merging into the same root (A + B + C).
 * 7. Invariant: Every prediction retains original analyst_id and is counted exactly once.
 */
export async function mergeAnalysts(
  userId: string,
  sourceAnalystId: string,
  targetAnalystId: string
): Promise<{ success: boolean; sourceId: string; targetId: string }> {
  if (sourceAnalystId === targetAnalystId) {
    throw new Error('Cannot merge an analyst into themselves');
  }

  return withTransaction(async (client) => {
    // 1. Verify both analysts belong to the user
    const sourceRes = await client.query<{ id: string; name: string; merged_into_id: string | null }>(`
      SELECT id, name, merged_into_id FROM analysts
      WHERE id = $1 AND user_id = $2;
    `, [sourceAnalystId, userId]);

    const targetRes = await client.query<{ id: string; name: string; merged_into_id: string | null }>(`
      SELECT id, name, merged_into_id FROM analysts
      WHERE id = $1 AND user_id = $2;
    `, [targetAnalystId, userId]);

    if (sourceRes.rows.length === 0 || targetRes.rows.length === 0) {
      throw new Error('One or both analysts not found or unauthorized');
    }

    const source = sourceRes.rows[0];
    const target = targetRes.rows[0];

    // 2. Prevent merging an already-merged analyst (prevents chains like B -> A, then B -> C)
    if (source.merged_into_id) {
      throw new Error('Cannot merge an analyst that is already merged into another profile');
    }

    // 3. Prevent merging into a target that is already merged (prevents chains like C -> B where B is merged into A)
    if (target.merged_into_id) {
      throw new Error('Cannot merge into an analyst that has been merged into another profile');
    }

    // 4. Prevent cycle attempts (e.g. if target was previously merged into source)
    const cycleCheck = await client.query(`
      SELECT id FROM analysts
      WHERE merged_into_id = $1 AND id = $2 AND user_id = $3;
    `, [sourceAnalystId, targetAnalystId, userId]);
    if (cycleCheck.rows.length > 0) {
      throw new Error('Cannot create a cyclic merge between these analysts');
    }

    // 5. Set merged_into_id on source
    await client.query(`
      UPDATE analysts
      SET merged_into_id = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3;
    `, [targetAnalystId, sourceAnalystId, userId]);

    // 6. Log audit row
    await client.query(`
      INSERT INTO analyst_merges (user_id, source_analyst_id, target_analyst_id)
      VALUES ($1, $2, $3);
    `, [userId, sourceAnalystId, targetAnalystId]);

    // 7. Log Walrus Outbox Event
    const memoryString = formatStructuredMemory({
      analystId: targetAnalystId,
      eventType: 'ANALYST_MERGED',
      sequenceNumber: Date.now(),
      payload: {
        action: 'MERGE',
        sourceAnalystId,
        targetAnalystId,
        timestamp: new Date().toISOString(),
      },
    });

    await client.query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status)
      VALUES ($1, $2, $3, 'PENDING');
    `, [userId, `merge-${sourceAnalystId}-${Date.now()}`, memoryString]);

    return {
      success: true,
      sourceId: sourceAnalystId,
      targetId: targetAnalystId,
    };
  });
}

/**
 * Reverses a previous merge (Unmerge)
 */
export async function unmergeAnalyst(
  userId: string,
  sourceAnalystId: string
): Promise<{ success: boolean; restoredId: string }> {
  return withTransaction(async (client) => {
    const aRes = await client.query<{ id: string; merged_into_id: string }>(`
      SELECT id, merged_into_id FROM analysts
      WHERE id = $1 AND user_id = $2;
    `, [sourceAnalystId, userId]);

    if (aRes.rows.length === 0 || !aRes.rows[0].merged_into_id) {
      throw new Error('Analyst is not currently merged');
    }

    const previousTarget = aRes.rows[0].merged_into_id;

    // 1. Clear merged_into_id
    await client.query(`
      UPDATE analysts
      SET merged_into_id = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2;
    `, [sourceAnalystId, userId]);

    // 2. Mark audit row reversed
    await client.query(`
      UPDATE analyst_merges
      SET reversed_at = NOW()
      WHERE source_analyst_id = $1 AND reversed_at IS NULL;
    `, [sourceAnalystId]);

    // 3. Log Outbox Event
    const memoryString = formatStructuredMemory({
      analystId: sourceAnalystId,
      eventType: 'ANALYST_MERGED',
      sequenceNumber: Date.now(),
      payload: {
        action: 'UNMERGE',
        sourceAnalystId,
        previousTargetId: previousTarget,
        timestamp: new Date().toISOString(),
      },
    });

    await client.query(`
      INSERT INTO memory_outbox (user_id, event_key, payload, status)
      VALUES ($1, $2, $3, 'PENDING');
    `, [userId, `unmerge-${sourceAnalystId}-${Date.now()}`, memoryString]);

    return {
      success: true,
      restoredId: sourceAnalystId,
    };
  });
}

/**
 * Lists all active (non-merged) analysts with their linked aliases and credibility summaries
 */
export async function listAnalysts(userId: string): Promise<AnalystRecord[]> {
  // 1. Fetch unmerged analysts
  const aRes = await query<AnalystRecord>(`
    SELECT id, user_id, name, merged_into_id, created_at, updated_at
    FROM analysts
    WHERE user_id = $1 AND merged_into_id IS NULL
    ORDER BY name ASC;
  `, [userId]);

  const analysts = aRes.rows;
  if (analysts.length === 0) return [];

  // 2. Fetch all aliases for these analysts
  const aliasRes = await query<AnalystAlias>(`
    SELECT id, analyst_id, platform, handle, created_at
    FROM analyst_aliases
    WHERE analyst_id IN (SELECT id FROM analysts WHERE user_id = $1)
    ORDER BY platform, handle;
  `, [userId]);

  const aliasMap: Record<string, AnalystAlias[]> = {};
  for (const a of aliasRes.rows) {
    if (!aliasMap[a.analyst_id]) aliasMap[a.analyst_id] = [];
    aliasMap[a.analyst_id].push(a);
  }

  // 3. Fetch predictions (including from merged sub-analysts) to calculate credibility
  const predRes = await query<{
    analyst_id: string;
    parent_analyst_id: string;
    outcome: string;
    verification: string;
  }>(`
    SELECT p.analyst_id, COALESCE(a.merged_into_id, a.id) AS parent_analyst_id, p.outcome, p.verification
    FROM predictions p
    JOIN analysts a ON p.analyst_id = a.id
    WHERE p.user_id = $1;
  `, [userId]);

  const predMap: Record<string, Array<{ outcome: string; verification: string }>> = {};
  for (const p of predRes.rows) {
    const targetId = p.parent_analyst_id;
    if (!predMap[targetId]) predMap[targetId] = [];
    predMap[targetId].push({ outcome: p.outcome, verification: p.verification });
  }

  // 4. Attach aliases & credibility
  return analysts.map(a => ({
    ...a,
    aliases: aliasMap[a.id] || [],
    credibility: computeCredibility(predMap[a.id] || [], a.id),
  }));
}

/**
 * Retrieves detailed profile for an analyst including merged profiles
 */
export async function getAnalystDetail(
  userId: string,
  analystId: string,
  options?: {
    reconstructOverride?: (userId: string, analystId: string) => Promise<any>;
  }
): Promise<AnalystRecord | null> {
  const aRes = await query<AnalystRecord>(`
    SELECT id, user_id, name, merged_into_id, created_at, updated_at
    FROM analysts
    WHERE id = $1 AND user_id = $2;
  `, [analystId, userId]);

  if (aRes.rows.length === 0) return null;
  const analyst = aRes.rows[0];

  // Fetch aliases
  const aliasRes = await query<AnalystAlias>(`
    SELECT id, analyst_id, platform, handle, created_at
    FROM analyst_aliases
    WHERE analyst_id = $1
    ORDER BY platform, handle;
  `, [analystId]);
  analyst.aliases = aliasRes.rows;

  // Fetch merged sub-analysts
  const mergedRes = await query<AnalystRecord>(`
    SELECT id, user_id, name, merged_into_id, created_at, updated_at
    FROM analysts
    WHERE merged_into_id = $1 AND user_id = $2;
  `, [analystId, userId]);
  analyst.mergedAnalysts = mergedRes.rows;

  // Fetch all predictions for this analyst (and any merged sub-analysts) with event info
  const predRes = await query<{
    id: string;
    event_id: string;
    market: string;
    selection: string;
    outcome: string;
    verification: string;
    created_at: string;
    event_label: string;
    start_at_utc: string;
    sport: string;
  }>(`
    SELECT
      p.id,
      p.event_id,
      p.market,
      p.selection,
      p.outcome,
      p.verification,
      p.created_at,
      e.label AS event_label,
      e.start_at_utc,
      e.sport
    FROM predictions p
    JOIN events e ON e.id = p.event_id
    WHERE p.user_id = $1 AND (p.analyst_id = $2 OR p.analyst_id IN (SELECT id FROM analysts WHERE merged_into_id = $2))
    ORDER BY p.created_at DESC;
  `, [userId, analystId]);

  analyst.credibility = computeCredibility(predRes.rows, analystId);

  // If no prediction history exists in PostgreSQL, integrity is NOT_APPLICABLE
  if (predRes.rows.length === 0) {
    analyst.integrity = {
      verified: false,
      status: 'NOT_APPLICABLE',
      warning: 'No prediction history exists to verify',
      gaps: [],
      tampered: 0,
    };
    analyst.predictions = [];
    return analyst;
  }

  try {
    const report = options?.reconstructOverride
      ? await options.reconstructOverride(userId, analystId)
      : await reconstructUserHistoryFromWalrus(userId, analystId);

    // 1. Confirmed Integrity Failures (cryptographic mismatch, sequence gaps, or report.success === false)
    if (!report.success || (report.tamperedEventsCount && report.tamperedEventsCount > 0) || (report.sequenceGapsDetected && report.sequenceGapsDetected.length > 0)) {
      analyst.integrity = {
        verified: false,
        status: 'FAILED',
        warning: report.error || 'Historical sequence gap or untrusted memory detected in Walrus record',
        gaps: report.sequenceGapsDetected || [],
        tampered: report.tamperedEventsCount || 0,
      };
      analyst.predictions = predRes.rows;
      return analyst;
    }

    // 2. Completeness Check: Reconcile operational PostgreSQL state with Walrus reconstruction
    const reconstructed = report.reconstructedPredictions || {};
    let missingPredictionsCount = 0;
    let missingSettlementsCount = 0;
    let outcomeMismatchDetected = false;

    for (const p of predRes.rows) {
      const rec = reconstructed[p.id];
      if (!rec) {
        missingPredictionsCount++;
      } else {
        // Check settlement tail record completeness
        if (p.outcome !== 'PENDING' && rec.outcome === 'PENDING') {
          missingSettlementsCount++;
        } else if (p.outcome !== 'PENDING' && rec.outcome !== p.outcome) {
          // Both are settled, but outcomes do not match -> integrity mismatch
          outcomeMismatchDetected = true;
        }
      }
    }

    if (outcomeMismatchDetected) {
      analyst.integrity = {
        verified: false,
        status: 'FAILED',
        warning: 'Historical settlement outcome mismatch detected between operational state and Walrus audit trail',
        gaps: [],
        tampered: 1,
      };
    } else if (missingPredictionsCount > 0 || missingSettlementsCount > 0) {
      const parts: string[] = [];
      if (missingPredictionsCount > 0) {
        parts.push(`${missingPredictionsCount} prediction(s) awaiting Walrus synchronization`);
      }
      if (missingSettlementsCount > 0) {
        parts.push(`${missingSettlementsCount} settlement record(s) pending Walrus synchronization`);
      }
      analyst.integrity = {
        verified: false,
        status: 'INCOMPLETE',
        warning: `History incomplete: ${parts.join(', ')}`,
        gaps: [],
        tampered: 0,
      };
    } else {
      // 3. Complete and verified
      analyst.integrity = {
        verified: true,
        status: 'VERIFIED',
        gaps: [],
        tampered: 0,
      };
    }
  } catch (err: any) {
    analyst.integrity = {
      verified: false,
      status: 'UNAVAILABLE',
      warning: err?.message ? `Walrus verification temporarily unavailable: ${err.message}` : 'Walrus verification temporarily unavailable',
      gaps: [],
      tampered: 0,
    };
  }
  analyst.predictions = predRes.rows;
  return analyst;
}
