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

export interface AnalystAlias {
  id: string;
  analyst_id: string;
  platform: 'TELEGRAM' | 'TWITTER' | 'YOUTUBE' | 'TIKTOK' | 'OTHER';
  handle: string;
  created_at: string;
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
    const checkRes = await client.query<{ id: string; name: string }>(`
      SELECT id, name FROM analysts
      WHERE id IN ($1, $2) AND user_id = $3;
    `, [sourceAnalystId, targetAnalystId, userId]);

    if (checkRes.rows.length < 2) {
      throw new Error('One or both analysts not found or unauthorized');
    }

    // 2. Set merged_into_id on source
    await client.query(`
      UPDATE analysts
      SET merged_into_id = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3;
    `, [targetAnalystId, sourceAnalystId, userId]);

    // 3. Log audit row
    await client.query(`
      INSERT INTO analyst_merges (user_id, source_analyst_id, target_analyst_id)
      VALUES ($1, $2, $3);
    `, [userId, sourceAnalystId, targetAnalystId]);

    // 4. Log Walrus Outbox Event
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
export async function getAnalystDetail(userId: string, analystId: string): Promise<AnalystRecord | null> {
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

  // Fetch all predictions for this analyst (and any merged sub-analysts)
  const predRes = await query<{ outcome: string; verification: string }>(`
    SELECT outcome, verification
    FROM predictions
    WHERE user_id = $1 AND (analyst_id = $2 OR analyst_id IN (SELECT id FROM analysts WHERE merged_into_id = $2));
  `, [userId, analystId]);

  analyst.credibility = computeCredibility(predRes.rows, analystId);
  return analyst;
}
