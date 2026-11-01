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
  // 1. Mandatory presence check for TEST_DATABASE_URL
  if (!testUrl || testUrl.trim() === '') {
    throw new Error(
      'FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL is not set.\n' +
      'Integration tests require an isolated test database and must NEVER run against DATABASE_URL.\n' +
      'Provide an independent test database connection via TEST_DATABASE_URL.'
    );
  }

  // 2. Mandatory presence check for DATABASE_URL (production identity required)
  if (!primaryUrl || primaryUrl.trim() === '') {
    throw new Error(
      'FATAL TEST ISOLATION FAILURE: DATABASE_URL is not set.\n' +
      'The primary database identity must be configured in test mode to verify test database isolation.'
    );
  }

  // Parse and normalize both URLs
  const testId = parsePgUrl(testUrl);
  const primaryId = parsePgUrl(primaryUrl);

  // 3. Reject known primary Supabase project ref unconditionally
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

  // 4. Reject identical raw URLs
  if (testUrl.trim() === primaryUrl.trim()) {
    throw new Error(
      'FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL is identical to DATABASE_URL.\n' +
      'Integration tests require an independent database instance.'
    );
  }

  // 5. Supabase provider identity check (evaluated before generic pooler host matching)
  if (testId.supabaseProjectRef && primaryId.supabaseProjectRef) {
    if (testId.supabaseProjectRef === primaryId.supabaseProjectRef) {
      throw new Error(
        `FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL shares the same Supabase project reference ("${testId.supabaseProjectRef}") as DATABASE_URL.`
      );
    }
    // Different verified Supabase project references route to distinct isolated databases
    return;
  }

  // 6. Reject matching normalized host, port, and database
  if (
    testId.host === primaryId.host &&
    testId.port === primaryId.port &&
    testId.database === primaryId.database
  ) {
    throw new Error(
      `FATAL TEST ISOLATION FAILURE: TEST_DATABASE_URL points to the same target (${testId.host}:${testId.port}/${testId.database}) as DATABASE_URL.`
    );
  }

  // 7. Local loopback test database check
  const isTestLocal = testId.host === 'localhost';
  const isPrimaryLocal = primaryId.host === 'localhost';

  if (isTestLocal) {
    if (!isPrimaryLocal) {
      // Local test database versus remote primary database: valid separation
      return;
    }
    // Both are local, but database name or port differs: valid separation
    if (testId.database !== primaryId.database || testId.port !== primaryId.port) {
      return;
    }
  }

  // 8. Fail-closed on unknown or ambiguous endpoint identities
  // Different hostnames alone do not prove different databases (DNS CNAMEs, poolers, aliases)
  throw new Error(
    `FATAL TEST ISOLATION FAILURE: Ambiguous database identity.\n` +
    `Cannot prove that test endpoint (${testId.host}:${testId.port}/${testId.database}) ` +
    `is isolated from primary endpoint (${primaryId.host}:${primaryId.port}/${primaryId.database}).\n` +
    `Use an explicit local test database (e.g. localhost) or a verified distinct provider project.`
  );
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

