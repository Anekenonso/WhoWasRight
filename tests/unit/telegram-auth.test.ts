/**
 * Unit Tests: Telegram Authentication Security Protocol
 *
 * Verifies:
 * 1. Valid HMAC-SHA256 signature verification using SHA-256(bot_token).
 * 2. Tampered user data rejection (cryptographic mismatch).
 * 3. Freshness checks (<24 hours old, no future timestamps).
 * 4. Session token generation and SHA-256 hash properties.
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { verifyTelegramLoginPayload } from '../../src/core/auth.ts';
import { generateSessionToken, hashSessionToken } from '../../src/core/crypto.ts';

export function runTelegramAuthUnitTests(): { passed: boolean; count: number; failures: string[] } {
  const failures: string[] = [];
  let count = 0;

  function assert(condition: boolean, testName: string) {
    count++;
    if (!condition) {
      failures.push(testName);
      console.error(`  [FAIL] ${testName}`);
    } else {
      console.log(`  [PASS] ${testName}`);
    }
  }

  console.log('\n--- Running Telegram Auth Unit Tests ---');

  const botToken = '1234567890:AAFl4vWExampleBotTokenForTestingOnly_123';
  const now = Math.floor(Date.now() / 1000);

  function signPayload(data: Record<string, string | number>, token: string): string {
    const checkString = Object.keys(data)
      .sort()
      .map(k => `${k}=${data[k]}`)
      .join('\n');
    const secretKey = createHash('sha256').update(token).digest();
    return createHmac('sha256', secretKey).update(checkString).digest('hex');
  }

  // 1. Valid Payload
  const validData: Record<string, string | number> = {
    id: 123456789,
    first_name: 'Alex',
    username: 'alex_picks',
    auth_date: now - 30, // 30s ago
  };
  const validHash = signPayload(validData, botToken);
  const r1 = verifyTelegramLoginPayload({ ...validData, hash: validHash }, botToken);
  assert(r1.valid, 'Valid fresh Telegram payload accepted');

  // 2. Tampered Data (Attacker modifies user ID)
  const tamperedData = { ...validData, id: 999999999, hash: validHash };
  const r2 = verifyTelegramLoginPayload(tamperedData, botToken);
  assert(!r2.valid, 'Tampered user ID rejected by HMAC check');

  // 3. Stale Payload (>24 hours)
  const staleData = { ...validData, auth_date: now - 90000 };
  const staleHash = signPayload(staleData, botToken);
  const r3 = verifyTelegramLoginPayload({ ...staleData, hash: staleHash }, botToken);
  assert(!r3.valid, 'Stale payload (>24 hours) rejected');

  // 4. Future Timestamp (>2 min in future)
  const futureData = { ...validData, auth_date: now + 500 };
  const futureHash = signPayload(futureData, botToken);
  const r4 = verifyTelegramLoginPayload({ ...futureData, hash: futureHash }, botToken);
  assert(!r4.valid, 'Future timestamp rejected');

  // 5. Wrong Bot Token
  const r5 = verifyTelegramLoginPayload({ ...validData, hash: validHash }, 'DIFFERENT_BOT_TOKEN');
  assert(!r5.valid, 'Signature evaluated with wrong bot token rejected');

  // 6. Session Token Properties
  const token1 = generateSessionToken();
  const token2 = generateSessionToken();
  assert(token1.length === 64, 'Session token is 64 hex characters (32 bytes)');
  assert(token1 !== token2, 'Generated session tokens are distinct');

  const hash1 = hashSessionToken(token1);
  const hash2 = hashSessionToken(token1);
  assert(hash1 === hash2, 'SHA-256 token hashing is deterministic');
  assert(hash1 !== token1, 'Token hash is not equal to plaintext token');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('telegram-auth.test.ts')) {
  const res = runTelegramAuthUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}

