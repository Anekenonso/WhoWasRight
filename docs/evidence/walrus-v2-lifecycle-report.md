# Walrus V2 Lifecycle & Reconstruction Evidence Report

**Project:** WhoWasRight (Track 01: Markets & Sports Prediction)  
**Execution Timestamp:** 2026-11-02T09:47:49Z  
**Test Suite:** `tests/integration/walrus-v2-lifecycle.test.ts`  
**Command:** `npm run test:walrus:lifecycle`  
**Verdict:** **100% PASS (30/30 INVARIANTS & INTEGRITY ASSERTIONS VERIFIED)**

---

## 1. Executive Summary

This report establishes verifiable, repeatable proof that WhoWasRight's Walrus V2 architecture executes the entire decentralized lifecycle without data loss, vector truncation, or database dependency:

$$\mathbf{CREATE} \longrightarrow \mathbf{OUTBOX} \longrightarrow \mathbf{WALRUS\ WRITE} \longrightarrow \mathbf{WALRUS\ RECALL} \longrightarrow \mathbf{HISTORY\ RECONSTRUCTION} \longrightarrow \mathbf{CREDIBILITY\ CALIBRATION}$$

### Key Invariants Proved:
1. **Zero Database Fallback:** The historical reconstruction engine (`reconstructFromWalrusMemories`) consumes *only* decrypted raw Walrus memory strings. It possesses zero database connection pool references and cannot cheat by querying PostgreSQL `predictions`.
2. **Top-K Vector Lossiness Mitigation:** Solved the semantic search truncation dilemma by wrapping every prediction and settlement in an ordered, sequence-numbered envelope (`[WWR:v1] [analyst:<id>] [type:<event>] [seq:<n>] [enc:<iv>:<tag>:<ciphertext>]`).
3. **Fail-Closed Tamper & Gap Detection:** If an adversary tampers with a single byte of ciphertext or drops a sequence number in the decentralized store, the reconstruction engine fails closed immediately (`success: false`).

---

## 2. Test Environment & Distinction of Evidence Levels

To maintain strict scientific integrity, evidence levels are explicitly distinguished below:

| Dimension | Mode / Level | Specification / Endpoint |
| :--- | :--- | :--- |
| **Local Lifecycle Test** | **Deterministic Integration** | Node.js 22.18+ TypeScript Native (`tests/integration/walrus-v2-lifecycle.test.ts`) |
| **Database Transactional Outbox** | **Simulated & Real Postgres Invariant** | Schema Migration 006 (`user_event_sequences`, `format_version = 2`) |
| **Walrus In-Memory Protocol** | **Mock Cluster (Protocol Faithful)** | Simulates `remember`, `waitForRememberJob`, and decentralized blob addressing |
| **Walrus Mainnet Writes** | **AUTHENTICATED MAINNET EVIDENCE** | 70+ Confirmed Memories on `https://relayer.memory.walrus.xyz` documented in [`walrus-history-proof.json`](walrus-history-proof.json) |
| **Sui Onchain Verification** | **LIVE SUI MAINNET (Tatum gRPC)** | HTTP/2 query on `MemWalAccount` object `0xc2225f53...` (Digest: `HCr2Qs1jc...`) |

---

## 3. Step-by-Step Lifecycle Event Trace

### Phase 1: Prediction Creation (`seq: 1..7`)
- **Action:** 7 distinct predictions logged for Analyst `0192e21b-6893-7850-84cf-eb95eb28c7c2` before match kickoff UTC.
- **Outbox Schema Invariant:** `format_version = 2`, `sequence_number = 1..7` (strictly contiguous monotonic sequence).
- **Encryption:** AES-256-GCM application-layer encryption with unique 12-byte IVs.
- **Outbox Transition:** `PENDING` $\to$ `IN_FLIGHT` $\to$ `CONFIRMED`.
- **Walrus Receipt:** 7 decentralized blobs confirmed.

### Phase 2: Match Settlement (`seq: 8..13`)
- **Action:** 6 predictions settled following official full-time match API evidence:
  - `pred-1`: WON
  - `pred-2`: WON
  - `pred-3`: WON
  - `pred-4`: WON
  - `pred-5`: LOST
  - `pred-6`: LOST
  - `pred-7`: PENDING (unsettled future fixture)
- **Sequence Range:** `seq: 8..13`.
- **Outbox Transition:** Confirmed in Walrus with unique Blob IDs.

### Phase 3: Result Correction (`seq: 14`)
- **Action:** Prediction 1 corrected from `WON` to `LOST` (e.g. referee VAR overturn post-match).
- **Event Type:** `CORRECTED` (replaces previous outcome while preserving full audit trail).
- **Sequence:** `seq: 14`.

### Phase 4: Lifecycle Extensions (`seq: 15..16`)
- **Analyst Merge (`seq: 15`):** Merges alias analyst profile into canonical root analyst with cycle and chain prevention.
- **Snapshot (`seq: 16`):** Records epoch 1 compaction checkpoint baseline.

---

## 4. Genuinely Independent Recall & Reconstruction Output

The reconstruction engine was supplied exclusively with the array of raw string envelopes retrieved from the Walrus store. All database references and outbox tables were severed.

### Credibility Calibration: Expected vs Reconstructed

$$\text{Decisive Win Rate} = \frac{\text{Won}}{\text{Won} + \text{Lost}} = \frac{3}{3 + 3} = 50.00\% \quad (\text{Minimum 6 Decisive Picks} \implies \text{Rating Tier: Average})$$

| Metric | Expected Value | Reconstructed Value | Result |
| :--- | :---: | :---: | :---: |
| **Total Events Processed** | 16 | 16 | **MATCH** |
| **Total Predictions Reconstructed** | 7 | 7 | **MATCH** |
| **Prediction 1 Final Outcome** | `LOST` (Corrected) | `LOST` | **MATCH** |
| **Prediction 7 Outcome** | `PENDING` | `PENDING` | **MATCH** |
| **Settled Predictions Count** | 6 | 6 | **MATCH** |
| **Decisive Won Count** | 3 | 3 | **MATCH** |
| **Decisive Lost Count** | 3 | 3 | **MATCH** |
| **Win Rate** | **50.00%** | **50.00%** | **MATCH** |
| **Rating Tier** | **Average** | **Average** | **MATCH** |
| **Tampered Events** | 0 | 0 | **MATCH** |
| **Sequence Gaps** | 0 | 0 | **MATCH** |
| **Overall Reconstruction Status** | `success: true` | `success: true` | **100% PASS** |

---

## 5. Negative & Adversarial Fail-Closed Tests

| Test Attack Vector | Injected Flaw | Expected Behavior | Observed Result | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Ciphertext Tampering** | Flipped 4 bytes in Event #3 ciphertext | Fail closed immediately; reject forged record | `report.success === false`<br>`tamperedEventsCount === 1` | **PASS** |
| **Sequence Omission** | Dropped Event #8 (`seq: 8`) from Walrus array | Fail closed; flag sequence discontinuity | `report.success === false`<br>`sequenceGapsDetected: [8]` | **PASS** |

---

## 6. Real Walrus Mainnet Proof Citations

For live production verification on Sui Mainnet, refer to the authenticated receipts in [`docs/evidence/walrus-history-proof.json`](walrus-history-proof.json):
- **Relayer:** `https://relayer.memory.walrus.xyz`
- **Walrus Mainnet Package ID:** `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`
- **Sui Shared Account Object:** `0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090`
- **Sample Mainnet Blob ID:** `h4TO8psqwWt64eTII2stzdg1g9YtCEE5Nb9iiQMjAbY` (Job: `6d7f7793-67e0-4d42-83dd-a213638347d7`)
- **Tatum Sui gRPC Method:** `/sui.rpc.v2.LedgerService/GetObject` (Digest: `HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK`)

