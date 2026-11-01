/**
 * Test Database Isolation & Safety Guard
 *
 * Enforces strict isolation boundaries between test suites and the primary database.
 * Guarantees that integration tests can never silently connect to or mutate
 * the primary application database.
 */

export interface PgConnectionIdentity {
  host: string;
  port: string;
  database: string;
  username: string;
  supabaseProjectRef: string | null;
}

/**
 * Parses and normalizes a PostgreSQL connection URL into comparable identity components.
 */
export function parsePgUrl(rawUrl: string): PgConnectionIdentity {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('Connection URL must be a non-empty string');
  }

  try {
    const parsed = new URL(rawUrl);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol "${parsed.protocol}"; expected postgres: or postgresql:`);
    }

    const host = parsed.hostname.toLowerCase();
    const port = parsed.port || '5432';
    const database = (parsed.pathname.replace(/^\//, '') || 'postgres').toLowerCase();
    const username = decodeURIComponent(parsed.username || '').toLowerCase();

    // Canonicalize localhost loopback representations
    const normalizedHost = (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') ? 'localhost' : host;

    // Detect Supabase project reference if present
    let supabaseProjectRef: string | null = null;

    // Pattern 1: Connection pooler format: user is postgres.<project-ref>
    const userMatch = username.match(/^postgres\.([a-z0-9_-]+)$/);
    if (userMatch) {
      supabaseProjectRef = userMatch[1];
    }

    // Pattern 2: Direct Supabase hostname format: db.<project-ref>.supabase.co
    const hostMatch = host.match(/^db\.([a-z0-9_-]+)\.supabase\.co$/);
    if (hostMatch) {
      supabaseProjectRef = hostMatch[1];
    }

    return {
      host: normalizedHost,
      port,
      database,
      username,
      supabaseProjectRef,
    };
  } catch (err: any) {
    throw new Error(`Failed to parse database connection URL: ${err.message}`);
  }
}

/**
 * Asserts that the test database URL is properly configured, distinct,
 * and isolated from the primary database.
 * Throws a fatal Error if any isolation rule is violated.
 */
export function assertDatabaseIsolation(testUrl: string | undefined, primaryUrl: string | undefined): void {
  // 1. Mandatory presence check
  if (!testUrl || testUrl.trim() === '') {
    throw new Error(
      'FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL is not set.\n' +
      'Integration tests require an isolated test database and must NEVER run against DATABASE_URL.\n' +
      'Provide an independent test database connection via TEST_DATABASE_URL.'
    );
  }

  const testId = parsePgUrl(testUrl);

  // 2. Reject known primary Supabase project ref unconditionally
  const KNOWN_PRIMARY_PROJECT = 'mecvtdrjwxjdzppyqfse';
  if (
    testId.supabaseProjectRef === KNOWN_PRIMARY_PROJECT ||
    testUrl.includes(KNOWN_PRIMARY_PROJECT)
  ) {
    throw new Error(
      `FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL targets the primary Supabase project ("${KNOWN_PRIMARY_PROJECT}").\n` +
      'Integration tests are strictly forbidden from connecting to the primary production/shared database.'
    );
  }

  // 3. If primary URL is known, compare normalized connection identities
  if (primaryUrl && primaryUrl.trim() !== '') {
    const primaryId = parsePgUrl(primaryUrl);

    // Reject identical raw URLs
    if (testUrl.trim() === primaryUrl.trim()) {
      throw new Error(
        'FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL is identical to DATABASE_URL.\n' +
        'Integration tests require an independent database instance.'
      );
    }

    // Reject matching Supabase project references across different poolers or ports
    if (
      testId.supabaseProjectRef &&
      primaryId.supabaseProjectRef &&
      testId.supabaseProjectRef === primaryId.supabaseProjectRef
    ) {
      throw new Error(
        `FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL shares the same Supabase project reference ("${testId.supabaseProjectRef}") as DATABASE_URL.`
      );
    }

    // Reject matching host + port + database combination
    if (
      testId.host === primaryId.host &&
      testId.port === primaryId.port &&
      testId.database === primaryId.database
    ) {
      throw new Error(
        `FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL points to the same target (${testId.host}:${testId.port}/${testId.database}) as DATABASE_URL.`
      );
    }
  }
}

/**
 * Checks whether the current Node.js process is executing a test context.
 */
export function isTestEnvironment(): boolean {
  if (process.env.NODE_ENV === 'test') {
    return true;
  }
  // Check CLI arguments for test execution
  return process.argv.some(arg => {
    const normalized = arg.replace(/\\/g, '/').toLowerCase();
    return normalized.includes('/tests/') || normalized.includes('tests/run-all-tests');
  });
}

/**
 * Enforces test database isolation for the current process.
 * Sets NODE_ENV to 'test' and validates TEST_DATABASE_URL.
 */
export function enforceTestDatabaseIsolation(): void {
  process.env.NODE_ENV = 'test';
  assertDatabaseIsolation(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
}

