/**
 * Phase 1 Master Test Runner
 *
 * Runs all Unit Tests (Credibility, Walrus Reconstruction, Telegram Auth, Football Cache)
 * and Database Domain Integration Tests.
 */

import { runCredibilityUnitTests } from './unit/credibility.test.ts';
import { runWalrusReconstructionUnitTests } from './unit/walrus-reconstruction.test.ts';
import { runTelegramAuthUnitTests } from './unit/telegram-auth.test.ts';
import { runFootballCacheUnitTests } from './unit/football-cache.test.ts';
import { runDatabaseDomainIntegrationTests } from './integration/database-domain.test.ts';
import { closeDbPool } from '../src/core/db.ts';

async function main() {
  const timestamp = new Date().toISOString();
  console.log('============================================================');
  console.log(`WHOWASRIGHT PHASE 1 MASTER TEST RUNNER`);
  console.log(`Execution Time: ${timestamp}`);
  console.log('============================================================');

  let totalTests = 0;
  let totalFailures: string[] = [];

  // 1. Credibility Unit Tests
  const credRes = runCredibilityUnitTests();
  totalTests += credRes.count;
  totalFailures.push(...credRes.failures);

  // 2. Walrus Reconstruction Unit Tests
  const walrusRes = runWalrusReconstructionUnitTests();
  totalTests += walrusRes.count;
  totalFailures.push(...walrusRes.failures);

  // 3. Telegram Auth Unit Tests
  const tgRes = runTelegramAuthUnitTests();
  totalTests += tgRes.count;
  totalFailures.push(...tgRes.failures);

  // 4. Football Cache Unit Tests
  const fbRes = runFootballCacheUnitTests();
  totalTests += fbRes.count;
  totalFailures.push(...fbRes.failures);

  // 5. Database Domain Integration Tests
  let dbRes = { passed: false, count: 0, failures: ['Database test not run'] };
  try {
    dbRes = await runDatabaseDomainIntegrationTests();
    totalTests += dbRes.count;
    totalFailures.push(...dbRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Database integration exception: ${(err as Error).message}`);
    console.error('Fatal Database Integration Error:', err);
  } finally {
    await closeDbPool();
  }

  // Summary
  const passedCount = totalTests - totalFailures.length;
  console.log('\n============================================================');
  console.log('PHASE 1 TEST EXECUTION SUMMARY');
  console.log('============================================================');
  console.log(`Total Invariants & Assertions Tested: ${totalTests}`);
  console.log(`Passed:                               ${passedCount}`);
  console.log(`Failed:                               ${totalFailures.length}`);

  if (totalFailures.length > 0) {
    console.error('\nFAILED TESTS:');
    totalFailures.forEach(f => console.error(`  - ${f}`));
    console.log('\nVERDICT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('\nVERDICT: ALL PHASE 1 INVARIANTS & INTEGRATION TESTS PASSED!');
    process.exitCode = 0;
  }
}

main().catch(err => {
  console.error('Master Test Runner Fatal Error:', err);
  process.exitCode = 1;
});

