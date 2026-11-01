/**
 * Integration Test Database Helper
 *
 * Dedicated database access point for integration tests.
 * Guarantees that:
 * 1. Isolation is verified before any connection can be attempted.
 * 2. All queries execute strictly against TEST_DATABASE_URL.
 * 3. Primary DATABASE_URL is never accessed.
 */

import {
  enforceTestDatabaseIsolation,
  assertDatabaseIsolation,
  parsePgUrl,
  type PgConnectionIdentity,
} from '../../src/core/test-isolation.ts';
import { getDbPool, query, withTransaction, closeDbPool } from '../../src/core/db.ts';

// Auto-enforce isolation upon module load
enforceTestDatabaseIsolation();

export {
  enforceTestDatabaseIsolation,
  assertDatabaseIsolation,
  parsePgUrl,
  getDbPool,
  query,
  withTransaction,
  closeDbPool,
  type PgConnectionIdentity,
};

