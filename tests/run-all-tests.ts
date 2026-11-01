/**
 * Phase 1, 2, 3, 4 & 5 Master Test Runner
 *
 * Runs all Unit Tests:
 * - Credibility, Walrus Reconstruction, Telegram Auth, Football Cache
 * - Rule-Based Paste Parser, Daily Limits, Football Settlement
 * - Phase 5: Telegram Bot Security & Football Settler Logic
 * And Integration Tests:
 * - Database Domain Integration (Phase 1)
 * - Analyst Management, Predictions, Merges (Phase 2 Record Slice)
 * - Web Server & Mobile UI Integration (Phase 2)
 * - Walrus Outbox, Reversibility, Replay & Integrity (Phase 3 Remember Slice)
 * - Gate 3 Outbox Resilience & Idempotency
 * - Phase 5 Bot Linking, Settlement & Notifications
 */

import { runCredibilityUnitTests } from './unit/credibility.test.ts';
import { runWalrusReconstructionUnitTests } from './unit/walrus-reconstruction.test.ts';
import { runTelegramAuthUnitTests } from './unit/telegram-auth.test.ts';
import { runFootballCacheUnitTests } from './unit/football-cache.test.ts';
import { runPasteParserUnitTests } from './unit/paste-parser.test.ts';
import { runDailyLimitsUnitTests } from './unit/daily-limits.test.ts';
import { runSettlementUnitTests } from './unit/settlement.test.ts';
import { runPhase5UnitTests } from './unit/phase5-telegram-settler.test.ts';
import { runTestIsolationUnitTests } from './unit/test-isolation.test.ts';
import { runSequenceAllocatorUnitTests } from './unit/sequence-allocator.test.ts';
import { enforceTestDatabaseIsolation } from '../src/core/test-isolation.ts';
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
  const settleRes = runSettlementUnitTests();
  totalTests += settleRes.count;
  totalFailures.push(...settleRes.failures);

  // 8. Phase 5 Telegram Bot & Football Settler Unit Tests
  const p5UnitRes = runPhase5UnitTests();
  totalTests += p5UnitRes.count;
  totalFailures.push(...p5UnitRes.failures);

  // 9. Test Database Isolation & Identity Policy Unit Tests
  const isolationRes = runTestIsolationUnitTests();
  totalTests += isolationRes.count;
  totalFailures.push(...isolationRes.failures);

  // 10. V2 Sequence Allocator Unit Tests
  const seqRes = await runSequenceAllocatorUnitTests();
  totalTests += seqRes.count;
  totalFailures.push(...seqRes.failures);

  // Enforce strict test database isolation before loading integration tests
  console.log('\n--- Enforcing Test Database Isolation Guard ---');
  enforceTestDatabaseIsolation();
  console.log('[PASS] Test database isolation boundary verified.');

  // Dynamically import integration tests only AFTER isolation guard passes
  const { runDatabaseDomainIntegrationTests } = await import('./integration/database-domain.test.ts');
  const { runPhase2IntegrationTests } = await import('./integration/phase2-record-slice.test.ts');
  const { runWebServerIntegrationTests } = await import('./integration/web-server.test.ts');
  const { runPhase3RememberSliceIntegrationTests } = await import('./integration/phase3-remember-slice.test.ts');
  const { runGate3OutboxResilienceTests } = await import('./integration/gate3-outbox-resilience.test.ts');
  const { runPhase5IntegrationTests } = await import('./integration/phase5-settlement.test.ts');
  const { runAuthHardeningCorrectionsTests } = await import('./integration/auth-hardening-corrections.test.ts');
  const { runWalrusIntegrityFailClosedTests } = await import('./integration/walrus-integrity-fail-closed.test.ts');

  let dbCount = 0;
  let p2Count = 0;
  let webCount = 0;
  let p3Count = 0;
  let gate3Count = 0;
  let p5IntCount = 0;
  let authHardeningCount = 0;
  let walrusIntegrityCount = 0;

  async function runWithTransientRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT') {
        console.log('Transient network error encountered, retrying in 1.5s...');
        await new Promise(r => setTimeout(r, 1500));
        return await fn();
      }
      throw err;
    }
  }

  // 9. Database Domain Integration Tests (Phase 1)
  try {
    const dbRes = await runWithTransientRetry(() => runDatabaseDomainIntegrationTests());
    dbCount = dbRes.count;
    totalTests += dbRes.count;
    totalFailures.push(...dbRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Database integration exception: ${(err as Error).message}`);
    console.error('Fatal Database Integration Error:', err);
  }

  // 10. Phase 2 Record Slice Integration Tests
  try {
    const p2Res = await runWithTransientRetry(() => runPhase2IntegrationTests());
    p2Count = p2Res.count;
    totalTests += p2Res.count;
    totalFailures.push(...p2Res.failures);
  } catch (err: unknown) {
    totalFailures.push(`Phase 2 integration exception: ${(err as Error).message}`);
    console.error('Fatal Phase 2 Integration Error:', err);
  }

  // 11. Web Server & Mobile UI Integration Tests
  try {
    const webRes = await runWithTransientRetry(() => runWebServerIntegrationTests());
    webCount = webRes.count;
    totalTests += webRes.count;
    totalFailures.push(...webRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Web Server integration exception: ${(err as Error).message}`);
    console.error('Fatal Web Server Integration Error:', err);
  }

  // 12. Phase 3 Remember Slice Integration Tests
  try {
    const p3Res = await runWithTransientRetry(() => runPhase3RememberSliceIntegrationTests());
    p3Count = p3Res.count;
    totalTests += p3Res.count;
    totalFailures.push(...p3Res.failures);
  } catch (err: unknown) {
    totalFailures.push(`Phase 3 integration exception: ${(err as Error).message}`);
    console.error('Fatal Phase 3 Integration Error:', err);
  }

  // 13. Gate 3 Outbox Resilience & Idempotency Tests
  try {
    const g3Res = await runWithTransientRetry(() => runGate3OutboxResilienceTests());
    gate3Count = g3Res.count;
    totalTests += g3Res.count;
    totalFailures.push(...g3Res.failures);
  } catch (err: unknown) {
    totalFailures.push(`Gate 3 Outbox Resilience integration exception: ${(err as Error).message}`);
    console.error('Fatal Gate 3 Outbox Resilience Integration Error:', err);
  }

  // 14. Phase 5 Bot Linking, Settlement & Notifications Integration Tests
  try {
    const p5IntRes = await runWithTransientRetry(() => runPhase5IntegrationTests());
    p5IntCount = p5IntRes.count;
    totalTests += p5IntRes.count;
    totalFailures.push(...p5IntRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Phase 5 integration exception: ${(err as Error).message}`);
    console.error('Fatal Phase 5 Integration Error:', err);
  }

  // 15. Auth Hardening & Demo Isolation Integration Tests
  try {
    const authRes = await runWithTransientRetry(() => runAuthHardeningCorrectionsTests());
    authHardeningCount = authRes.count;
    totalTests += authRes.count;
    totalFailures.push(...authRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Auth Hardening integration exception: ${(err as Error).message}`);
    console.error('Fatal Auth Hardening Integration Error:', err);
  }

  // 16. Walrus Integrity Fail-Closed Integration Tests
  try {
    const walrusIntRes = await runWithTransientRetry(() => runWalrusIntegrityFailClosedTests());
    walrusIntegrityCount = walrusIntRes.count;
    totalTests += walrusIntRes.count;
    totalFailures.push(...walrusIntRes.failures);
  } catch (err: unknown) {
    totalFailures.push(`Walrus Integrity Fail-Closed integration exception: ${(err as Error).message}`);
    console.error('Fatal Walrus Integrity Fail-Closed Integration Error:', err);
  } finally {
    await closeDbPool();
  }

  // Summary
  const passedCount = totalTests - totalFailures.length;
  console.log('\n============================================================');
  console.log('MASTER TEST EXECUTION SUMMARY (PROGRAMMATIC BREAKDOWN)');
  console.log('============================================================');
  console.log(`1. Credibility Unit Tests:                   ${credRes.count} tests`);
  console.log(`2. Walrus Historical Reconstruction Tests:   ${walrusRes.count} tests`);
  console.log(`3. Telegram Auth Unit Tests:                 ${tgRes.count} tests`);
  console.log(`4. Football Cache Unit Tests:                ${fbRes.count} tests`);
  console.log(`5. Paste Parser Unit Tests:                  ${pasteRes.count} tests`);
  console.log(`6. Daily Limits Unit Tests:                  ${dailyRes.count} tests`);
  console.log(`7. Football Settlement Unit Tests:           ${settleRes.count} tests`);
  console.log(`8. Phase 5 Unit Tests (Bot & Settler):       ${p5UnitRes.count} tests`);
  console.log(`9. Database Domain Integration Tests:        ${dbCount} tests`);
  console.log(`10. Phase 2 Record Slice Integration Tests:  ${p2Count} tests`);
  console.log(`11. Web Server & UI Integration Tests:       ${webCount} tests`);
  console.log(`12. Phase 3 Remember Slice Tests:            ${p3Count} tests`);
  console.log(`13. Gate 3 Outbox Resilience Tests:          ${gate3Count} tests`);
  console.log(`14. Phase 5 Integration Tests (Settlement):  ${p5IntCount} tests`);
  console.log(`15. Auth Hardening & Demo Isolation Tests:    ${authHardeningCount} tests`);
  console.log(`16. Walrus Integrity Fail-Closed Tests:       ${walrusIntegrityCount} tests`);
  console.log('------------------------------------------------------------');
  console.log(`Total Invariants & Assertions Tested: ${totalTests}`);
  console.log(`Total Passed:                         ${passedCount}`);
  console.log(`Total Failed:                         ${totalFailures.length}`);

  if (totalFailures.length > 0) {
    console.error('\nFAILED TESTS:');
    totalFailures.forEach(f => console.error(`  - ${f}`));
    console.log('\nVERDICT: FAIL');
    process.exit(1);
  } else {
    console.log('\nVERDICT: ALL PHASE 1, 2, 3, 4 & 5 INVARIANTS & INTEGRATION TESTS PASSED!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Master Test Runner Fatal Error:', err);
  process.exit(1);
});
