/**
 * Unit Tests: Test Database Isolation Guard & Identity Policy
 *
 * Verifies all 10 isolation cases using pure-function synthetic assertions.
 * Zero database connections or network requests.
 */

import { parsePgUrl, assertDatabaseIsolation } from '../../src/core/test-isolation.ts';

export function runTestIsolationUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Test Database Isolation Unit Tests ---');

  const PROD_URL = 'postgresql://postgres.mecvtdrjwxjdzppyqfse:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  const PROD_POOLER_ALT = 'postgresql://postgres.mecvtdrjwxjdzppyqfse:secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres';
  const PROD_DIRECT = 'postgresql://postgres:secret@db.mecvtdrjwxjdzppyqfse.supabase.co:5432/postgres';
  const DIFF_SUPABASE_A = 'postgresql://postgres.projectalpha:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  const DIFF_SUPABASE_B = 'postgresql://postgres.projectbeta:secret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  const LOCAL_TEST_DB = 'postgresql://postgres:password@localhost:5432/whowasright_test';
  const ARBITRARY_REMOTE_A = 'postgresql://user:pass@db-a.company.com:5432/db';
  const ARBITRARY_REMOTE_B = 'postgresql://user:pass@db-b.company.com:5432/db';

  // 1. Missing DATABASE_URL
  try {
    assertDatabaseIsolation(LOCAL_TEST_DB, undefined);
    assert(false, 'Case 1: Missing DATABASE_URL must be rejected');
  } catch (err: any) {
    assert(err.message.includes('DATABASE_URL is not set'), 'Case 1: Missing DATABASE_URL rejected');
  }

  // 2. Missing TEST_DATABASE_URL
  try {
    assertDatabaseIsolation(undefined, PROD_URL);
    assert(false, 'Case 2: Missing TEST_DATABASE_URL must be rejected');
  } catch (err: any) {
    assert(err.message.includes('TEST_DATABASE_URL is not set'), 'Case 2: Missing TEST_DATABASE_URL rejected');
  }

  // 3a. Malformed test URL
  try {
    assertDatabaseIsolation('not-a-pg-url', PROD_URL);
    assert(false, 'Case 3a: Malformed TEST_DATABASE_URL must be rejected');
  } catch (err: any) {
    assert(err.message.includes('Failed to parse database connection URL'), 'Case 3a: Malformed TEST_DATABASE_URL rejected');
  }

  // 3b. Malformed prod URL
  try {
    assertDatabaseIsolation(LOCAL_TEST_DB, 'not-a-pg-url');
    assert(false, 'Case 3b: Malformed DATABASE_URL must be rejected');
  } catch (err: any) {
    assert(err.message.includes('Failed to parse database connection URL'), 'Case 3b: Malformed DATABASE_URL rejected');
  }

  // 4. Same Supabase project through different poolers
  try {
    assertDatabaseIsolation(PROD_POOLER_ALT, PROD_URL);
    assert(false, 'Case 4: Same Supabase project across poolers must be rejected');
  } catch (err: any) {
    assert(err.message.includes('targets the primary Supabase project'), 'Case 4: Same Supabase project across poolers rejected');
  }

  // 5. Same Supabase project through direct and pooler endpoints
  try {
    assertDatabaseIsolation(PROD_DIRECT, PROD_URL);
    assert(false, 'Case 5: Same Supabase direct vs pooler must be rejected');
  } catch (err: any) {
    assert(err.message.includes('targets the primary Supabase project'), 'Case 5: Same Supabase direct vs pooler rejected');
  }

  // 6. Different Supabase project references
  try {
    assertDatabaseIsolation(DIFF_SUPABASE_A, DIFF_SUPABASE_B);
    assert(true, 'Case 6: Different Supabase project references accepted');
  } catch (err: any) {
    assert(false, `Case 6: Different Supabase project references should be accepted but threw: ${err.message}`);
  }

  // 7. Same PostgreSQL database through different query parameters
  try {
    assertDatabaseIsolation(
      'postgresql://user:pass@localhost:5432/mydb?sslmode=require',
      'postgresql://user:pass@localhost:5432/mydb?sslmode=disable'
    );
    assert(false, 'Case 7: Same database with different query params must be rejected');
  } catch (err: any) {
    assert(err.message.includes('points to the same target'), 'Case 7: Same database with different query params rejected');
  }

  // 8. Different arbitrary hostnames with no reliable provider identity (fail closed on ambiguous identity)
  try {
    assertDatabaseIsolation(ARBITRARY_REMOTE_B, ARBITRARY_REMOTE_A);
    assert(false, 'Case 8: Ambiguous remote endpoints must be rejected');
  } catch (err: any) {
    assert(err.message.includes('Ambiguous database identity'), 'Case 8: Ambiguous remote endpoints rejected');
  }

  // 9. Local isolated test database versus remote production database
  try {
    assertDatabaseIsolation(LOCAL_TEST_DB, PROD_URL);
    assert(true, 'Case 9: Local test database vs remote production database accepted');
  } catch (err: any) {
    assert(false, `Case 9: Local test DB vs remote production DB should be accepted but threw: ${err.message}`);
  }

  // 10. The existing production project blacklist
  try {
    assertDatabaseIsolation(
      'postgresql://postgres.mecvtdrjwxjdzppyqfse:secret@some-proxy.internal:5432/postgres',
      'postgresql://postgres.otherproject:secret@db.otherproject.supabase.co:5432/postgres'
    );
    assert(false, 'Case 10: Production project blacklist must be rejected unconditionally');
  } catch (err: any) {
    assert(err.message.includes('targets the primary Supabase project'), 'Case 10: Production project blacklist rejected unconditionally');
  }

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('test-isolation.test.ts')) {
  const result = runTestIsolationUnitTests();
  process.exitCode = result.passed ? 0 : 1;
}

