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

export function getAppEncryptionKey(): Buffer {
  const hex = process.env.MEMORY_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error('MEMORY_ENCRYPTION_KEY is not configured');
  }
  const cleanHex = hex.replace(/^0x/, '');
  const buf = Buffer.from(cleanHex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`MEMORY_ENCRYPTION_KEY must be exactly 32 bytes (got ${buf.length})`);
  }
  return buf;
}

export function encryptRecord(data: unknown, key?: Buffer): EncryptedPayload {
  const encKey = key || getAppEncryptionKey();
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

export function decryptRecord<T>(payload: EncryptedPayload, key?: Buffer): T {
  const encKey = key || getAppEncryptionKey();
  const iv = Buffer.from(payload.iv, 'hex');
  const tag = Buffer.from(payload.tag, 'hex');
  const ct = Buffer.from(payload.ciphertext, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

/**
 * Encodes structured memory envelope:
 * [WWR:v1] [analyst:<id>] [type:<event>] [seq:<n>] [enc:<iv>:<tag>:<ciphertext>]
 */
export function formatStructuredMemory(params: {
  analystId: string;
  eventType: 'CREATED' | 'SETTLED' | 'CORRECTED' | 'ANALYST_MERGED' | 'SNAPSHOT';
  sequenceNumber: number | bigint;
  payload: unknown;
  key?: Buffer;
}): string {
  const enc = encryptRecord(params.payload, params.key);
  const encBlock = `[enc:${enc.iv}:${enc.tag}:${enc.ciphertext}]`;
  return `[WWR:v1] [analyst:${params.analystId}] [type:${params.eventType}] [seq:${params.sequenceNumber}] ${encBlock}`;
}

/**
 * Parses structured memory envelope and extracts metadata + encrypted payload
 */
export function parseStructuredMemory(memoryText: string): {
  version: string;
  analystId: string;
  eventType: string;
  sequenceNumber: number;
  encryptedPayload: EncryptedPayload;
} | null {
  const regex = /\[WWR:([^\]]+)\]\s+\[analyst:([^\]]+)\]\s+\[type:([^\]]+)\]\s+\[seq:([^\]]+)\]\s+\[enc:([^:]+):([^:]+):([^\]]+)\]/;
  const match = memoryText.match(regex);
  if (!match) return null;

  return {
    version: match[1],
    analystId: match[2],
    eventType: match[3],
    sequenceNumber: parseInt(match[4], 10),
    encryptedPayload: {
      iv: match[5],
      tag: match[6],
      ciphertext: match[7],
    },
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

