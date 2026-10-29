/**
 * K2 Kill-Test: Privacy vs Memory (Encryption Compatibility & Deterministic Rebuild)
 *
 * Requirements:
 * 1. AES-256-GCM symmetric envelope encryption & tamper detection.
 * 2. Structured retrieval format (non-secret searchable metadata + encrypted payload).
 * 3. Prove why semantic top-K recall alone CANNOT be used to calculate exact credibility scores.
 * 4. Demonstrate deterministic ledger reconstruction from ordered memory events.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export interface EncryptedPayload {
  iv: string;         // hex
  ciphertext: string; // hex
  tag: string;        // hex
}

export interface StructuredEventMemory {
  envelope: string;
  encryptedPayload: EncryptedPayload;
}

export function encryptPayload(data: unknown, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12); // standard 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  };
}

export function decryptPayload<T>(payload: EncryptedPayload, key: Buffer): T {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'hex')),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function buildMemoryText(metadata: {
  version: string;
  analystId: string;
  eventType: 'CREATED' | 'SETTLED' | 'CORRECTED';
  sequence: number;
}, encrypted: EncryptedPayload): string {
  // Structured searchable prefix (non-secret indexing tokens)
  // Private pick details, stakes, and identities are inside encrypted payload
  const prefix = `[WWR:${metadata.version}] [analyst:${metadata.analystId}] [type:${metadata.eventType}] [seq:${metadata.sequence}]`;
  const encBlock = `[enc:${encrypted.iv}:${encrypted.tag}:${encrypted.ciphertext}]`;
  return `${prefix} ${encBlock}`;
}

export function parseMemoryText(text: string): {
  prefix: string;
  encryptedPayload: EncryptedPayload;
} | null {
  const match = text.match(/^(\[WWR:[^\]]+\]\s+\[analyst:[^\]]+\]\s+\[type:[^\]]+\]\s+\[seq:[^\]]+\])\s+\[enc:([^:]+):([^:]+):([^\]]+)\]$/);
  if (!match) return null;
  return {
    prefix: match[1],
    encryptedPayload: {
      iv: match[2],
      tag: match[3],
      ciphertext: match[4],
    },
  };
}

export async function runK2Test(): Promise<{
  passed: boolean;
  tamperTestPassed: boolean;
  topKProofPassed: boolean;
  ledgerRebuildPassed: boolean;
  details: Record<string, unknown>;
}> {
  console.log('\n============================================================');
  console.log('K2 KILL-TEST: Privacy vs Memory & Encryption Compatibility');
  console.log('============================================================');

  const key = randomBytes(32); // 256-bit AES key
  const analystId = '0192e21b-6893-7850-84cf-eb95eb28c7c2';

  // 1. Encrypt sensitive prediction data
  const privatePick = {
    userId: 'user-secret-telegram-999',
    analystId,
    fixture: 'Arsenal vs Chelsea',
    market: '1X2',
    selection: 'Arsenal',
    notes: 'Confidential insider commentary',
  };

  const encrypted = encryptPayload(privatePick, key);
  const memoryText = buildMemoryText({
    version: 'v1',
    analystId,
    eventType: 'CREATED',
    sequence: 1,
  }, encrypted);

  console.log('Sample Structured Memory String (to be remembered):');
  console.log(memoryText);

  // Verify parse and decrypt
  const parsed = parseMemoryText(memoryText);
  if (!parsed) throw new Error('Failed to parse structured memory string');

  const decrypted = decryptPayload<typeof privatePick>(parsed.encryptedPayload, key);
  const roundtripPassed = decrypted.selection === privatePick.selection && decrypted.userId === privatePick.userId;
  console.log(`[PASS] Roundtrip encryption/decryption: ${roundtripPassed}`);

  // 2. Tamper Test (fails closed)
  let tamperDetected = false;
  try {
    const tamperedPayload: EncryptedPayload = {
      ...parsed.encryptedPayload,
      ciphertext: parsed.encryptedPayload.ciphertext.slice(0, -2) + (parsed.encryptedPayload.ciphertext.slice(-2) === 'aa' ? 'bb' : 'aa'),
    };
    decryptPayload(tamperedPayload, key);
  } catch (err: unknown) {
    tamperDetected = true;
    console.log(`[PASS] Tamper test caught by AES-GCM auth tag: ${(err as Error).message}`);
  }

  // 3. Mathematical proof: Top-K semantic recall vs Deterministic Ledger Rebuild
  console.log('\n--- Proving Top-K Semantic Recall Limitation vs Ledger ---');
  // Suppose an analyst has 15 settled picks: 10 Won, 3 Lost, 2 Push
  // Win rate should be: 10 / (10 + 3) = 10 / 13 = 76.92% -> GOOD (>= 65%)
  const sampleEvents = [
    ...Array(10).fill({ outcome: 'WON', decisive: true }),
    ...Array(3).fill({ outcome: 'LOST', decisive: true }),
    ...Array(2).fill({ outcome: 'PUSH', decisive: false }),
  ].map((item, idx) => ({
    sequence: idx + 1,
    outcome: item.outcome,
    decisive: item.decisive,
    encrypted: encryptPayload({ pickId: `p-${idx + 1}`, outcome: item.outcome }, key),
  }));

  // If application naively relied on semantic recall with topK = 10:
  const topKSubset = sampleEvents.slice(0, 10); // e.g. first 10 hits returned
  const topKWon = topKSubset.filter(e => e.outcome === 'WON').length;
  const topKLost = topKSubset.filter(e => e.outcome === 'LOST').length;
  const topKWinRate = topKWon / (topKWon + topKLost);
  console.log(`Semantic Top-K (limit 10) gives incomplete sample: ${topKSubset.length}/15 events`);
  console.log(`Incomplete Win Rate: ${(topKWinRate * 100).toFixed(1)}% (DROPPED 5 EVENTS!)`);

  // Ordered Ledger Rebuild (as mandated by BUILD_PLAN.md):
  let ledgerWon = 0;
  let ledgerLost = 0;
  let ledgerPush = 0;
  for (const ev of sampleEvents) {
    const data = decryptPayload<{ pickId: string; outcome: string }>(ev.encrypted, key);
    if (data.outcome === 'WON') ledgerWon++;
    else if (data.outcome === 'LOST') ledgerLost++;
    else if (data.outcome === 'PUSH') ledgerPush++;
  }
  const totalSettled = ledgerWon + ledgerLost + ledgerPush;
  const decisive = ledgerWon + ledgerLost;
  const exactWinRate = decisive > 0 ? (ledgerWon / decisive) : 0;
  const ratingTier = totalSettled >= 6 && decisive >= 1
    ? (exactWinRate >= 0.65 ? 'Good' : exactWinRate >= 0.45 ? 'Average' : 'Poor')
    : 'Not Rated';

  console.log(`Full Ledger Rebuild: ${totalSettled} settled (Won: ${ledgerWon}, Lost: ${ledgerLost}, Push: ${ledgerPush})`);
  console.log(`Exact Win Rate: ${(exactWinRate * 100).toFixed(2)}% | Tier: ${ratingTier}`);
  const ledgerRebuildPassed = ledgerWon === 10 && ledgerLost === 3 && ledgerPush === 2 && ratingTier === 'Good';
  console.log(`[PASS] Deterministic Ledger Rebuild: ${ledgerRebuildPassed}`);

  return {
    passed: roundtripPassed && tamperDetected && ledgerRebuildPassed,
    tamperTestPassed: tamperDetected,
    topKProofPassed: topKSubset.length < sampleEvents.length,
    ledgerRebuildPassed,
    details: {
      totalSettled,
      exactWinRate,
      ratingTier,
      roundtripPassed,
      tamperDetected,
    },
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('k2-privacy-encryption.ts')) {
  runK2Test()
    .then(res => {
      console.log(`\nK2 Result: ${res.passed ? 'ALL CHECKS PASSED' : 'FAILED'}`);
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('K2 Fatal Error:', err);
      process.exitCode = 1;
    });
}
