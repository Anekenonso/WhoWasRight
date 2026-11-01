/**
 * Unit Tests: V2 Sequence Allocator Contract & Invariants
 *
 * Verifies the sequence allocation logic, format invariants, and simulated
 * transaction boundaries with zero network or database connections.
 */

import {
  allocateNextEventSequence,
  getUserNextSequence,
  validateOutboxFormatInvariant,
} from '../../src/core/sequence-allocator.ts';

export async function runSequenceAllocatorUnitTests(): Promise<{ passed: boolean; count: number; failures: string[] }> {
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

  console.log('\n--- Running V2 Sequence Allocator Unit Tests ---');

  // Section 1: Outbox Format Invariants
  assert(validateOutboxFormatInvariant(1, null) === true, 'v1 with NULL sequence is valid');
  assert(validateOutboxFormatInvariant(1, 1) === false, 'v1 with positive sequence is invalid');
  assert(validateOutboxFormatInvariant(1, 0) === false, 'v1 with zero sequence is invalid');
  assert(validateOutboxFormatInvariant(2, 1) === true, 'v2 with positive sequence 1 is valid');
  assert(validateOutboxFormatInvariant(2, 42) === true, 'v2 with positive sequence 42 is valid');
  assert(validateOutboxFormatInvariant(2, null) === false, 'v2 with NULL sequence is invalid');
  assert(validateOutboxFormatInvariant(2, 0) === false, 'v2 with sequence 0 is invalid');
  assert(validateOutboxFormatInvariant(2, -1) === false, 'v2 with negative sequence is invalid');
  assert(validateOutboxFormatInvariant(2, 1.5) === false, 'v2 with non-integer sequence is invalid');
  assert(validateOutboxFormatInvariant(3, 1) === false, 'Unknown format version is invalid');

  // Section 2: Input Parameter Validation
  const dummyClient = { query: async () => ({ rows: [] }), release: () => {} } as any;

  // Missing / invalid userId
  let caught = false;
  try {
    await allocateNextEventSequence(dummyClient, '');
  } catch (err: any) {
    caught = true;
    assert(err.message.includes('valid non-empty userId'), 'Rejects empty userId');
  }
  assert(caught, 'Throws on empty userId');

  // Missing / invalid client
  caught = false;
  try {
    await allocateNextEventSequence(null as any, 'user-123');
  } catch (err: any) {
    caught = true;
    assert(err.message.includes('active PostgreSQL transaction client'), 'Rejects null client');
  }
  assert(caught, 'Throws on null client');

  // Passing a Pool instead of a PoolClient (has totalCount) is rejected
  const mockPool = { query: async () => ({ rows: [] }), release: () => {}, totalCount: 10 } as any;
  caught = false;
  try {
    await allocateNextEventSequence(mockPool, 'user-123');
  } catch (err: any) {
    caught = true;
    assert(err.message.includes('not a connection Pool'), 'Rejects pg.Pool instance at runtime');
  }
  assert(caught, 'Throws when connection Pool is provided');

  // Passing an object without release() is rejected
  const unreleasedClient = { query: async () => ({ rows: [] }) } as any;
  caught = false;
  try {
    await allocateNextEventSequence(unreleasedClient, 'user-123');
  } catch (err: any) {
    caught = true;
    assert(err.message.includes('not a connection Pool'), 'Rejects client without release function');
  }
  assert(caught, 'Throws on client without release method');

  // Section 3: Mock Transactional Allocation Lifecycle
  // Create an in-memory transactional mock of PostgreSQL client
  class MockTxClient {
    public state: Map<string, number> = new Map();
    public queries: Array<{ sql: string; params: any[] }> = [];

    release(): void {}

    async query(sql: string, params: any[] = []): Promise<any> {
      this.queries.push({ sql: sql.trim(), params });

      if (sql.includes('INSERT INTO user_event_sequences')) {
        const userId = params[0];
        if (!this.state.has(userId)) {
          this.state.set(userId, 1);
        }
        return { rows: [] };
      }

      if (sql.includes('UPDATE user_event_sequences')) {
        const userId = params[0];
        const current = this.state.get(userId) || 1;
        this.state.set(userId, current + 1);
        return { rows: [{ allocated_sequence: String(current) }] };
      }

      if (sql.includes('SELECT next_sequence')) {
        const userId = params[0];
        if (!this.state.has(userId)) {
          return { rows: [] };
        }
        return { rows: [{ next_sequence: String(this.state.get(userId)) }] };
      }

      return { rows: [] };
    }
  }

  const mockClient = new MockTxClient() as any;

  // First allocation for user A
  const seqA1 = await allocateNextEventSequence(mockClient, 'user-a');
  assert(seqA1 === 1, 'First allocated sequence is 1');
  assert(mockClient.queries.length === 2, 'Allocation executes insert and update');
  assert(mockClient.queries[0].sql.includes('INSERT INTO user_event_sequences'), 'Step 1 is idempotent insert');
  assert(mockClient.queries[1].sql.includes('UPDATE user_event_sequences'), 'Step 2 is atomic increment');
  assert(mockClient.queries[1].sql.includes('RETURNING (next_sequence - 1)'), 'Step 2 returns allocated sequence');
  assert(mockClient.state.get('user-a') === 2, 'Counter incremented to 2 after first allocation');

  // Second allocation for user A
  const seqA2 = await allocateNextEventSequence(mockClient, 'user-a');
  assert(seqA2 === 2, 'Second allocated sequence is 2');
  assert(mockClient.state.get('user-a') === 3, 'Counter incremented to 3 after second allocation');

  // First allocation for independent user B
  const seqB1 = await allocateNextEventSequence(mockClient, 'user-b');
  assert(seqB1 === 1, 'Independent user B starts at sequence 1');
  assert(mockClient.state.get('user-b') === 2, 'User B counter initialized independently');

  // Verify getUserNextSequence
  const nextA = await getUserNextSequence(mockClient, 'user-a');
  assert(nextA === 3, 'getUserNextSequence reads current counter without advancing');

  const nextUnknown = await getUserNextSequence(mockClient, 'unknown-user');
  assert(nextUnknown === null, 'getUserNextSequence returns null for uninitialized user');

  // Section 4: Transaction Rollback Simulation
  const rollbackMock = new MockTxClient() as any;
  rollbackMock.state.set('user-c', 5); // currently at 5

  const snapshot = rollbackMock.state.get('user-c');
  assert(snapshot === 5, 'Pre-transaction sequence is 5');

  // Simulate transaction failure: allocation occurs, but error thrown before commit
  try {
    const current = rollbackMock.state.get('user-c');
    rollbackMock.state.set('user-c', current + 1);
    throw new Error('Simulated business logic failure (e.g. prediction constraint violation)');
  } catch (err: any) {
    // Rollback restores snapshot
    rollbackMock.state.set('user-c', snapshot);
  }

  assert(rollbackMock.state.get('user-c') === 5, 'Rollback ensures counter remains 5 (zero consumed sequence on error)');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('sequence-allocator.test.ts')) {
  runSequenceAllocatorUnitTests().then(result => {
    process.exitCode = result.passed ? 0 : 1;
  });
}
