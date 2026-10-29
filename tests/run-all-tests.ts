/**
 * Phase 1, 2 & 3 Master Test Runner
 *
 * Runs all Unit Tests:
 * - Credibility, Walrus Reconstruction, Telegram Auth, Football Cache
 * - Rule-Based Paste Parser, Daily Limits, Football Settlement
 * And Integration Tests:
 * - Database Domain Integration (Phase 1)
 * - Analyst Management, Predictions, Merges (Phase 2 Record Slice)
 * - Web Server & Mobile UI Integration (Phase 2)
 * - Walrus Outbox, Reversibility, Replay & Integrity (Phase 3 Remember Slice)
 */

import { runCredibilityUnitTests } from './unit/credibility.test.ts';
import { runWalrusReconstructionUnitTests } from './unit/walrus-reconstruction.test.ts';
import { runTelegramAuthUnitTests } from './unit/telegram-auth.test.ts';
import { runFootballCacheUnitTests } from './unit/football-cache.test.ts';
import { runPasteParserUnitTests } from './unit/paste-parser.test.ts';
import { runDailyLimitsUnitTests } from './unit/daily-limits.test.ts';
import { runSettlementUnitTests } from './unit/settlement.test.ts';
import { runDatabaseDomainIntegrationTests } from './integration/database-domain.test.ts';
import { runPhase2IntegrationTests } from './integration/phase2-record-slice.test.ts';
import { runWebServerIntegrationTests } from './integration/web-server.test.ts';
import { runPhase3RememberSliceIntegrationTests } from './integration/phase3-remember-slice.test.ts';
import { closeDbPool } from '../src/core/db.ts';

async function main() {
  const timestamp = new Date().toISOString();
  console.log('============================================================');
  console.log(`WHOWASRIGHT PHASE 1, 2 & 3 MASTER TEST RUNNER`);
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

  // 5. Paste Parser Unit Tests
  const pasteRes = runPasteParserUnitTests();
  totalTests += pasteRes.count;
  totalFailures.push(...pasteRes.failures);

  // 6. Daily Limits Unit Tests
  const dailyRes = runDailyLimitsUnitTests();
  totalTests += dailyRes.count;
  totalFailures.push(...dailyRes.failures);

  // 7. Football Settlement Unit Tests
  const settleRes = await runSettlementUnitTests();
  totalTests += settleRes.count;
  totalFailures.push(...settleRes.failures);

  // 8. Database Domain Integration Tests (Phase 1)
  try {
    const dbRes = await runDatabaseDomainIntegrationTests();
    totalTests += dbRes.count;
    totalFailures.push(...dbRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Database integration exception: ${(err as Error).message}`);
    console.error('Fatal Database Integration Error:', err);
  }

  // 9. Phase 2 Record Slice Integration Tests
  try {
    const p2Res = await runPhase2IntegrationTests();
    totalTests += p2Res.count;
    totalFailures.push(...p2Res.failures);
  } catch (err: unknown) {
    totalFailures.push(`Phase 2 integration exception: ${(err as Error).message}`);
    console.error('Fatal Phase 2 Integration Error:', err);
  }

  // 10. Web Server & Mobile UI Integration Tests
  try {
    const webRes = await runWebServerIntegrationTests();
    totalTests += webRes.count;
    totalFailures.push(...webRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Web Server integration exception: ${(err as Error).message}`);
    console.error('Fatal Web Server Integration Error:', err);
  }

  // 11. Phase 3 Remember Slice Integration Tests
  try {
    const p3Res = await runPhase3RememberSliceIntegrationTests();
    totalTests += p3Res.count;
    totalFailures.push(...p3Res.failures);
  } catch (err: unknown) {
    totalFailures.push(`Phase 3 integration exception: ${(err as Error).message}`);
    console.error('Fatal Phase 3 Integration Error:', err);
  } finally {
    await closeDbPool();
  }

  // Summary
  const passedCount = totalTests - totalFailures.length;
  console.log('\n============================================================');
  console.log('MASTER TEST EXECUTION SUMMARY');
  console.log('============================================================');
  console.log(`Total Invariants & Assertions Tested: ${totalTests}`);
  console.log(`Passed:                               ${passedCount}`);
  console.log(`Failed:                               ${totalFailures.length}`);

  if (totalFailures.length > 0) {
    console.error('\nFAILED TESTS:');
    totalFailures.forEach(f => console.error(`  - ${f}`));
    console.log('\nVERDICT: FAIL');
    process.exit(1);
  } else {
    console.log('\nVERDICT: ALL PHASE 1, 2 & 3 INVARIANTS & INTEGRATION TESTS PASSED!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Master Test Runner Fatal Error:', err);
  process.exit(1);
});

