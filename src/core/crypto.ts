/**
 * Cryptographic Services
 *
 * Implements:
 * 1. AES-256-GCM envelope encryption/decryption for Walrus Memory events.
 * 2. SHA-256 hashing for opaque session tokens.
 * 3. HMAC-SHA256 for Telegram Login verification and webhook validation.
 * 4. Structured Memory Envelope format: [WWR:v1] [analyst:<id>] [type:<event>] [seq:<n>] [enc:<iv>:<tag>:<ct>]
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';

export interface EncryptedPayload {
  iv: string;         // 12-byte (24 hex chars)
  tag: string;        // 16-byte (32 hex chars)
  ciphertext: string; // variable hex
}

export function getAppEncryptionKey(version = 1): Buffer {
  let hex: string | undefined;
  if (version === 1) {
    hex = process.env.MEMORY_ENCRYPTION_KEY_V1 || process.env.MEMORY_ENCRYPTION_KEY;
  } else {
    hex = process.env[`MEMORY_ENCRYPTION_KEY_V${version}`];
  }

  if (!hex) {
    throw new Error(`MEMORY_ENCRYPTION_KEY (version ${version}) is not configured`);
  }
  const cleanHex = hex.replace(/^0x/, '');
  const buf = Buffer.from(cleanHex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`MEMORY_ENCRYPTION_KEY (version ${version}) must be exactly 32 bytes (got ${buf.length})`);
  }
  return buf;
}

export function encryptRecord(data: unknown, key?: Buffer, version = 1): EncryptedPayload {
  const encKey = key || getAppEncryptionKey(version);
  const iv = randomBytes(12); // standard 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);

  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

export function decryptRecord<T>(payload: EncryptedPayload, key?: Buffer, version = 1): T {
  const encKey = key || getAppEncryptionKey(version);
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ct = Buffer.from(payload.ciphertext, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

/**
 * Encodes structured memory envelope with explicit key version:
 * [WWR:v1] [kv:<version>] [analyst:<id>] [type:<event>] [seq:<n>] [enc:<iv>:<tag>:<ciphertext>]
 */
export function formatStructuredMemory(params: {
  analystId: string;
  eventType: 'CREATED' | 'SETTLED' | 'CORRECTED' | 'ANALYST_MERGED' | 'SNAPSHOT';
  sequenceNumber: number | bigint;
  payload: unknown;
  key?: Buffer;
  keyVersion?: number;
}): string {
  const keyVer = params.keyVersion ?? 1;
  const enc = encryptRecord(params.payload, params.key, keyVer);
  const encBlock = `[enc:${enc.iv}:${enc.tag}:${enc.ciphertext}]`;
  return `[WWR:v1] [kv:${keyVer}] [analyst:${params.analystId}] [type:${params.eventType}] [seq:${params.sequenceNumber}] ${encBlock}`;
}

/**
 * Parses structured memory envelope and extracts metadata + encrypted payload.
 * Fully backward-compatible with legacy envelopes omitting [kv:<n>], defaulting to keyVersion = 1.
 */
export function parseStructuredMemory(memoryText: string): {
  version: string;
  keyVersion: number;
  analystId: string;
  eventType: string;
  sequenceNumber: number;
  encryptedPayload: EncryptedPayload;
} | null {
  const regex = /\[WWR:([^\]]+)\](?:\s+\[kv:(\d+)\])?\s+\[analyst:([^\]]+)\]\s+\[type:([^\]]+)\]\s+\[seq:([^\]]+)\]\s+\[enc:([^:]+):([^:]+):([^\]]+)\]/;
  const match = memoryText.match(regex);
  if (!match) return null;

  return {
    version: match[1],
    keyVersion: match[2] ? parseInt(match[2], 10) : 1,
    analystId: match[3],
    eventType: match[4],
    sequenceNumber: parseInt(match[5], 10),
    encryptedPayload: {
      iv: match[6],
      tag: match[7],
      ciphertext: match[8],
    },
  };
}

/**
 * Decrypts structured memory envelope with automatic key-version resolution.
 * Fails closed on unknown key versions, tampered ciphertexts, or corrupt tags.
 */
export function decryptStructuredMemory<T>(memoryText: string, customKey?: Buffer): {
  metadata: { version: string; keyVersion: number; analystId: string; eventType: string; sequenceNumber: number };
  payload: T;
} {
  const parsed = parseStructuredMemory(memoryText);
  if (!parsed) {
    throw new Error('Malformed structured memory envelope');
  }

  const key = customKey || getAppEncryptionKey(parsed.keyVersion);
  const payload = decryptRecord<T>(parsed.encryptedPayload, key, parsed.keyVersion);

  return {
    metadata: {
      version: parsed.version,
      keyVersion: parsed.keyVersion,
      analystId: parsed.analystId,
      eventType: parsed.eventType,
      sequenceNumber: parsed.sequenceNumber,
    },
    payload,
  };
}

/**
 * Hashes an opaque session token with SHA-256 for secure database storage
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Generates a high-entropy random session token (32 random bytes = 64 hex characters)
 */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

