# Integration Blockers & Remaining Actions
**Generated (UTC):** 2026-10-29T05:54:02.413Z  

## Identified Limitations & Architectural Solutions

1. **Walrus Semantic Top-K vs Deterministic Credibility:**
   - *Limitation:* `memwal.recall()` is an approximate nearest-neighbor vector search returning at most `topK` memories (default 10). Calculating win rates solely from `recall()` drops older picks when count > topK.
   - *Architectural Solution:* Maintain an ordered local event ledger (`memory_receipts` in Postgres) synced with `listMemories()`. Reconstruct exact ratings deterministically rather than relying on lossy vector recall.

2. **Telegram Login Widget Domain Verification:**
   - *Limitation:* Telegram Login Widget rejects `localhost`.
   - *Action Required:* Operator must configure production/staging domain via BotFather (`/setdomain`) once the web app is deployed to HTTPS.

3. **Football API Free Quota Management:**
   - *Limitation:* Free plan provides 100 requests/day.
   - *Architectural Solution:* Implement batch polling and only poll matches after full-time (confirmed kickoff + 105 minutes), preserving quota.
