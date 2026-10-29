/**
 * Unit Tests: Rule-Based Paste Assistance
 *
 * Verifies:
 * 1. Multi-prediction clause extraction (e.g. "Arsenal to win. Over 2.5 goals.").
 * 2. Event label extraction (e.g. "Chelsea vs Liverpool - BTTS Yes").
 * 3. 1X2, BTTS, and Over/Under pattern recognition.
 * 4. Fails safe: Ambiguous text is flagged unparsed without hallucinating.
 * 5. Deduplication of repeated predictions in same paste.
 * 6. Always flags `requiresReview: true`.
 */

import { parsePredictionPaste } from '../../src/core/paste-parser.ts';

export function runPasteParserUnitTests(): { passed: boolean; count: number; failures: string[] } {
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

  console.log('\n--- Running Paste Parser Unit Tests ---');

  // Test 1: Multi-prediction parsing (Arsenal to win. Over 2.5 goals.)
  const t1 = parsePredictionPaste('Arsenal to win. Over 2.5 goals.');
  assert(t1.requiresReview === true, 'Parse result flags requiresReview === true');
  assert(t1.candidates.length === 2, 'Parsed 2 distinct candidates');
  assert(t1.candidates[0].market === '1X2' && t1.candidates[0].selection === 'Arsenal', 'Candidate 1: 1X2 Arsenal');
  assert(t1.candidates[1].market === 'TOTAL_GOALS' && t1.candidates[1].selection === 'Over 2.5', 'Candidate 2: Over 2.5');

  // Test 2: Event label extraction + BTTS
  const t2 = parsePredictionPaste('Chelsea vs Liverpool - BTTS Yes');
  assert(t2.extractedEventLabel === 'Chelsea vs Liverpool', 'Extracted event label: Chelsea vs Liverpool');
  assert(t2.candidates.length === 1, 'Parsed 1 candidate');
  assert(t2.candidates[0].market === 'BTTS' && t2.candidates[0].selection === 'Yes', 'Candidate is BTTS Yes');

  // Test 3: Total goals variations (O2.5, Under 1.5, U3.5)
  const t3 = parsePredictionPaste('O2.5 goals and Under 1.5');
  assert(t3.candidates.length === 2, 'Parsed both Over 2.5 and Under 1.5');
  assert(t3.candidates[0].selection === 'Over 2.5', 'Normalized O2.5 to Over 2.5');
  assert(t3.candidates[1].selection === 'Under 1.5', 'Normalized Under 1.5');

  // Test 4: BTTS variations (Goal/Goal, Both teams not to score)
  const t4 = parsePredictionPaste('Real Madrid vs Barcelona: Goal/Goal');
  assert(t4.candidates.length === 1, 'Goal/Goal parsed as BTTS');
  assert(t4.candidates[0].market === 'BTTS' && t4.candidates[0].selection === 'Yes', 'Goal/Goal is BTTS Yes');

  // Test 5: Ambiguous text falls back to unparsed (No hallucination!)
  const t5 = parsePredictionPaste('Expect a very tight match in midfield with lots of fouls');
  assert(t5.candidates.length === 0, 'Ambiguous non-standard text produces 0 candidates');
  assert(t5.unparsedFragments.length > 0, 'Ambiguous text kept in unparsedFragments');

  // Test 6: Deduplication of duplicate clauses in paste
  const t6 = parsePredictionPaste('Arsenal to win, Over 2.5. Over 2.5 goals.');
  assert(t6.candidates.length === 2, 'Repeated Over 2.5 deduplicated to single candidate');

  return {
    passed: failures.length === 0,
    count,
    failures,
  };
}

// Allow direct CLI execution
if (process.argv[1]?.replace(/\\/g, '/').endsWith('paste-parser.test.ts')) {
  const res = runPasteParserUnitTests();
  process.exitCode = res.passed ? 0 : 1;
}

