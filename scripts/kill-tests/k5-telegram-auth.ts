/**
 * K5 Kill-Test: Telegram Authentication Protocol Verification
 *
 * Requirements:
 * 1. Implement official Telegram login validation (HMAC-SHA256).
 * 2. Verify data_check_string sorting and hash validation.
 * 3. Enforce replay / freshness check (auth_date within 24h, not in future).
 * 4. Verify that altered payload fails authentication closed.
 */

import { createHash, createHmac } from 'node:crypto';

export interface TelegramAuthPayload {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

/**
 * Validates Telegram Login Widget payload according to official specs:
 * https://core.telegram.org/widgets/login#checking-authorization
 */
export function verifyTelegramLogin(
  payload: Record<string, string | number>,
  botToken: string,
  maxAgeSeconds = 86400 // 24 hours
): {
  valid: boolean;
  reason?: string;
  user?: {
    id: string;
    firstName?: string;
    lastName?: string;
    username?: string;
    authDate: number;
  };
} {
  const { hash, ...data } = payload;
  if (!hash || typeof hash !== 'string') {
    return { valid: false, reason: 'Missing signature hash' };
  }

  // 1. Freshness check
  const authDate = Number(data.auth_date);
  if (!authDate || isNaN(authDate)) {
    return { valid: false, reason: 'Missing or invalid auth_date' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60) {
    return { valid: false, reason: 'auth_date is in the future' };
  }
  if (now - authDate > maxAgeSeconds) {
    return { valid: false, reason: 'Payload has expired (older than 24 hours)' };
  }

  // 2. Build data_check_string: alphabetical sort of key=value pairs joined with \n
  const checkArr: string[] = [];
  const sortedKeys = Object.keys(data).sort();
  for (const key of sortedKeys) {
    const val = data[key];
    if (val !== undefined && val !== null) {
      checkArr.push(`${key}=${val}`);
    }
  }
  const dataCheckString = checkArr.join('\n');

  // 3. Compute secret key = SHA256(botToken)
  const secretKey = createHash('sha256').update(botToken).digest();

  // 4. Compute expected hash = HMAC-SHA256(secretKey, dataCheckString)
  const computedHash = createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  // 5. Compare hashes
  if (computedHash.toLowerCase() !== hash.toLowerCase()) {
    return { valid: false, reason: 'Cryptographic hash mismatch (tampered payload)' };
  }

  return {
    valid: true,
    user: {
      id: String(data.id),
      firstName: data.first_name ? String(data.first_name) : undefined,
      lastName: data.last_name ? String(data.last_name) : undefined,
      username: data.username ? String(data.username) : undefined,
      authDate,
    },
  };
}

/**
 * Helper to generate valid Telegram payload for testing
 */
export function generateTestTelegramPayload(
  userData: { id: string | number; first_name?: string; username?: string; auth_date: number },
  botToken: string
): TelegramAuthPayload {
  const checkArr: string[] = [];
  const sortedKeys = Object.keys(userData).sort() as (keyof typeof userData)[];
  for (const key of sortedKeys) {
    checkArr.push(`${key}=${userData[key]}`);
  }
  const dataCheckString = checkArr.join('\n');
  const secretKey = createHash('sha256').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return {
    ...userData,
    hash,
  };
}

export async function runK5Test(): Promise<{
  passed: boolean;
  tests: Array<{ name: string; expected: boolean; actual: boolean; passed: boolean }>;
}> {
  console.log('\n============================================================');
  console.log('K5 KILL-TEST: Telegram Authentication Security Protocol');
  console.log('============================================================');

  const dummyBotToken = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz_TEST_TOKEN';
  const now = Math.floor(Date.now() / 1000);

  // 1. Valid fresh payload
  const validUser = {
    id: '987654321',
    first_name: 'Alex',
    username: 'alex_sports_picks',
    auth_date: now - 30, // 30 seconds ago
  };
  const validPayload = generateTestTelegramPayload(validUser, dummyBotToken);

  const t1 = verifyTelegramLogin(validPayload as Record<string, string | number>, dummyBotToken);
  console.log(`[${t1.valid ? 'PASS' : 'FAIL'}] Valid fresh login: valid=${t1.valid} (User: ${t1.user?.username})`);

  // 2. Tampered payload (modified user ID)
  const tamperedPayload = {
    ...validPayload,
    id: '999999999', // Attacker attempts to impersonate different ID
  };
  const t2 = verifyTelegramLogin(tamperedPayload, dummyBotToken);
  console.log(`[${!t2.valid ? 'PASS' : 'FAIL'}] Tampered user ID caught: valid=${t2.valid} (${t2.reason})`);

  // 3. Stale payload (>24h old)
  const stalePayload = generateTestTelegramPayload(
    { ...validUser, auth_date: now - 100000 }, // ~28 hours ago
    dummyBotToken
  );
  const t3 = verifyTelegramLogin(stalePayload as Record<string, string | number>, dummyBotToken);
  console.log(`[${!t3.valid ? 'PASS' : 'FAIL'}] Stale payload (>24h) rejected: valid=${t3.valid} (${t3.reason})`);

  // 4. Future payload rejected
  const futurePayload = generateTestTelegramPayload(
    { ...validUser, auth_date: now + 500 }, // in future
    dummyBotToken
  );
  const t4 = verifyTelegramLogin(futurePayload as Record<string, string | number>, dummyBotToken);
  console.log(`[${!t4.valid ? 'PASS' : 'FAIL'}] Future timestamp rejected: valid=${t4.valid} (${t4.reason})`);

  // 5. Wrong bot token
  const t5 = verifyTelegramLogin(validPayload as Record<string, string | number>, 'DIFFERENT_BOT_TOKEN');
  console.log(`[${!t5.valid ? 'PASS' : 'FAIL'}] Wrong bot secret rejected: valid=${t5.valid} (${t5.reason})`);

  const tests = [
    { name: 'Valid fresh payload', expected: true, actual: t1.valid, passed: t1.valid },
    { name: 'Tampered user ID', expected: false, actual: t2.valid, passed: !t2.valid },
    { name: 'Stale payload (>24h)', expected: false, actual: t3.valid, passed: !t3.valid },
    { name: 'Future timestamp', expected: false, actual: t4.valid, passed: !t4.valid },
    { name: 'Wrong bot token', expected: false, actual: t5.valid, passed: !t5.valid },
  ];

  const allPassed = tests.every(t => t.passed);
  console.log(`\nTelegram Auth Security Tests: ${tests.filter(t => t.passed).length}/${tests.length} passed.`);

  return {
    passed: allPassed,
    tests,
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('k5-telegram-auth.ts')) {
  runK5Test()
    .then(res => {
      console.log(`\nK5 Result: ${res.passed ? 'ALL CHECKS PASSED' : 'FAILED'}`);
      process.exitCode = res.passed ? 0 : 1;
    })
    .catch(err => {
      console.error('K5 Fatal Error:', err);
      process.exitCode = 1;
    });
}

