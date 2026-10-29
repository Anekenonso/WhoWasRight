/**
 * Deterministic Rule-Based Paste Assistance
 *
 * Requirements:
 * 1. ZERO AI/LLM integration: 100% deterministic pattern matching and tokenization.
 * 2. Never invent missing details: Ambiguous fragments fall back to manual entry.
 * 3. User Review Required: Always flags `requiresReview: true`. No automatic submission.
 * 4. Deduplication: Ensures parsed candidate list has no internal duplicates.
 */

export interface ParsedPickCandidate {
  market: '1X2' | 'BTTS' | 'TOTAL_GOALS';
  selection: string;
  rawFragment: string;
  confidence: 'HIGH' | 'MEDIUM';
}

export interface ParseResult {
  rawInput: string;
  extractedEventLabel?: string;
  candidates: ParsedPickCandidate[];
  unparsedFragments: string[];
  requiresReview: true;
}

export function parsePredictionPaste(text: string): ParseResult {
  const cleanInput = text.trim();
  if (!cleanInput) {
    return {
      rawInput: text,
      candidates: [],
      unparsedFragments: [],
      requiresReview: true,
    };
  }

  const candidates: ParsedPickCandidate[] = [];
  const unparsed: string[] = [];

  // 1. Check for Event Label pattern: "Team A vs Team B"
  let extractedEventLabel: string | undefined = undefined;
  const matchRegex = /([A-Z0-9a-z\s]+?)\s+(?:vs\.?|versus|v\b)\s+([A-Z0-9a-z\s]+?)(?:\s*[-:,\n]|$)/i;
  const matchFound = cleanInput.match(matchRegex);
  if (matchFound) {
    const teamA = matchFound[1].trim();
    const teamB = matchFound[2].trim();
    if (teamA.length >= 2 && teamB.length >= 2 && !teamA.toLowerCase().includes('over') && !teamB.toLowerCase().includes('goals')) {
      extractedEventLabel = `${teamA} vs ${teamB}`;
    }
  }

  // 2. Split input into clause fragments by period-space, newline, semicolon, comma, hyphen, or "and"
  // Avoid splitting decimal points in numbers like 2.5
  const fragments = cleanInput
    .split(/(?:\r?\n|;|,|\s+-\s+|\s+and\s+|\.(?:\s+|$))+/i)
    .map(f => f.trim())
    .filter(f => f.length > 0);

  for (const frag of fragments) {
    // If the fragment is just the fixture name, skip it from candidate parsing
    if (extractedEventLabel && frag.toLowerCase() === extractedEventLabel.toLowerCase()) {
      continue;
    }

    let parsed = false;

    // A. Total Goals Patterns (Over/Under)
    const ouMatch = frag.match(/\b(over|under|o|u)\s*([0-9]\.5)\b(?:\s*goals?)?/i);
    if (ouMatch) {
      const dir = ouMatch[1].toUpperCase().startsWith('O') ? 'Over' : 'Under';
      const line = ouMatch[2];
      const selection = `${dir} ${line}`;
      candidates.push({
        market: 'TOTAL_GOALS',
        selection,
        rawFragment: frag,
        confidence: 'HIGH',
      });
      parsed = true;
    }

    // B. Both Teams to Score (BTTS) Patterns
    if (!parsed) {
      const bttsMatch = frag.match(/\b(?:btts|both\s+teams?\s+to\s+score)\s*(?:is\s*)?[:=-]?\s*(yes|no|y|n)\b/i);
      if (bttsMatch) {
        const isYes = bttsMatch[1].toUpperCase().startsWith('Y');
        candidates.push({
          market: 'BTTS',
          selection: isYes ? 'Yes' : 'No',
          rawFragment: frag,
          confidence: 'HIGH',
        });
        parsed = true;
      } else if (/\b(btts\s*yes|goal\/goal|both\s+teams\s+score)\b/i.test(frag)) {
        candidates.push({
          market: 'BTTS',
          selection: 'Yes',
          rawFragment: frag,
          confidence: 'HIGH',
        });
        parsed = true;
      } else if (/\b(btts\s*no|no\s*goal|both\s+teams\s+not\s+to\s+score)\b/i.test(frag)) {
        candidates.push({
          market: 'BTTS',
          selection: 'No',
          rawFragment: frag,
          confidence: 'HIGH',
        });
        parsed = true;
      }
    }

    // C. 1X2 / Match Winner Patterns
    if (!parsed) {
      // "<Team> to win" or "<Team> win"
      const winMatch = frag.match(/^([A-Za-z0-9\s]+?)\s+(?:to\s+win|win|victory)$/i);
      if (winMatch) {
        const team = winMatch[1].trim();
        // Disqualify if team is a generic phrase
        if (team.length >= 2 && !['btts', 'over', 'under'].includes(team.toLowerCase())) {
          candidates.push({
            market: '1X2',
            selection: team,
            rawFragment: frag,
            confidence: 'HIGH',
          });
          parsed = true;
        }
      } else if (/\b(draw|tie|match\s*drawn)\b/i.test(frag)) {
        candidates.push({
          market: '1X2',
          selection: 'Draw',
          rawFragment: frag,
          confidence: 'HIGH',
        });
        parsed = true;
      } else if (/\b1x2\s*[:=-]?\s*(1|x|2|home|away|draw)\b/i.test(frag)) {
        const codeMatch = frag.match(/\b1x2\s*[:=-]?\s*(1|x|2|home|away|draw)\b/i);
        const code = codeMatch ? codeMatch[1].toUpperCase() : '1';
        candidates.push({
          market: '1X2',
          selection: code === '1' ? 'Home' : code === '2' ? 'Away' : 'Draw',
          rawFragment: frag,
          confidence: 'HIGH',
        });
        parsed = true;
      }
    }

    if (!parsed) {
      // Do not invent or guess; flag as unparsed
      unparsed.push(frag);
    }
  }

  // 3. Deduplicate candidates internally (e.g. if text mentions "Over 2.5" twice)
  const uniqueCandidates: ParsedPickCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.market}:${c.selection.toUpperCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCandidates.push(c);
    }
  }

  return {
    rawInput: text,
    extractedEventLabel,
    candidates: uniqueCandidates,
    unparsedFragments: unparsed,
    requiresReview: true,
  };
}

