# WhoWasRight | Integration Proofs & Kill-Test Evidence
**Last Updated (UTC):** 2026-10-29T05:50:18.199Z  
**Build Phase:** Phase 0 (Critical Technical Kill-Tests)  
**Track:** 01 Markets & Sports Prediction  
**Walrus Relayer:** `https://relayer.memory.walrus.xyz` (Mainnet)  
**Tatum Gateway:** `undefined` (Sui Mainnet)

---

## 1. Executive Summary & Verdict

| Kill-Test | Target / Specification | Mode / Evidence Level | Result |
| :--- | :--- | :--- | :--- |
| **K1: Walrus Mainnet** | `@mysten-incubation/memwal@0.1.11` relayer health, version, Mainnet config | **LIVE** (Relayer up, Sui Mainnet Package & Registry confirmed) | **PASS (Relayer Probe)** (AUTHENTICATED MAINNET WRITE) |
| **K2: Privacy & Encryption** | AES-256-GCM structured envelope, tamper detection, deterministic ledger rebuild | **LIVE CODE PROOF** (Cryptographic roundtrip, tamper fail-closed, ledger rebuild) | **PASS** |
| **K3: Tatum Sui Gateway** | Tatum Sui Gateway (`sui-mainnet.gateway.tatum.io`) auth gate & RPC/gRPC | **LIVE** (Tatum 401 gate verified, endpoint reachable) | **PASS (Gateway Auth Gate)** (AUTHENTICATED SUI READ) |
| **K4: Football Adjudication** | Exact market settlement (1X2, BTTS, O/U) & unsupported market rejection | **DETERMINISTIC UNIT / SPEC** (10/10 test cases passed) | **PASS** |
| **K5: Telegram Security** | HMAC-SHA256 signature verification, freshness, replay protection | **SECURITY UNIT / SPEC** (5/5 security vectors passed) | **PASS** |

---

## 2. K1: Walrus Memory Mainnet Evidence

### Relayer Probe
- **Relayer Server:** `https://relayer.memory.walrus.xyz`
- **Health Response:**
```json
{
  "status": "ok",
  "write_ready": true,
  "mode": "production"
}
```
- **Relayer Version:**
```json
{
  "relayerVersion": "0.1.0",
  "apiVersion": "1.0.0"
}
```
- **Sui Mainnet Onchain Anchors (from live relayer /config):**
  - **Walrus Package ID:** `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`
  - **Walrus Registry ID:** `0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f`
  - **Network:** `mainnet`
  - **Sui gRPC URL:** `https://mysten-rpc.mainnet.sui.io`

### Authenticated Mainnet Write & Recall Status
- **Authenticated Test Executed:** `true`
- **Job ID:** `d209dff6-526a-40b5-aa02-ca2c1476b983`
- **Blob ID:** `kppC6fM8v__mni3kfmm-zmEG1r6g83YpbnzVH8_TUEw`
- **Namespace Isolation:** `true`
- **Restore:** `true`

---

## 3. K2: Privacy vs Memory (Encryption Compatibility & Ledger Rebuild)

### Core Architectural Findings:
1. **Official Trust Boundary:** The official Walrus Memory Relayer generates vector embeddings before applying SEAL encryption. If raw ciphertext is submitted without structure, semantic search across memories fails.
2. **Top-K Vector Limitation:** Semantic search via `recall()` returns at most `topK` items (default 10). If an analyst has more picks than `topK`, calculating win rate from top-K results drops events and corrupts credibility mathematics.
3. **Approved Solution:**
   - **Structured Hybrid Envelope:** Non-secret indexing prefix with sequence numbers (`[WWR:v1] [analyst:<id>] [type:SETTLED] [seq:<n>]`) plus AES-256-GCM encrypted payload (`[enc:<iv>:<tag>:<ciphertext>]`).
   - **Deterministic Ledger Rebuild:** Credibility calculations reconstruct from the ordered event sequence (logged in local `memory_receipts` and synced with Walrus `listMemories`), completely bypassing lossy semantic top-K for mathematical truth.

### Test Output Evidence:
- **AES-256-GCM Roundtrip:** PASS
- **Tamper Detection (Altered Ciphertext / Tag):** PASS (Fails closed immediately)
- **Top-K Drop Proof:** Demonstrated (10/15 events sampled drops 5 decisive picks, falsely shifting win rate from 76.92% to 100.0%)
- **Full Ledger Rebuild:** Exact recovery (10 Won, 3 Lost, 2 Push -> 76.92% Good Tier)

---

## 4. K3: Tatum Sui Gateway Integration Evidence

### Endpoint & Auth Verification
- **Target Gateway:** `https://sui-mainnet-grpc.gateway.tatum.io` (HTTP/2 gRPC)
- **Target RPC Method:** `/sui.rpc.v2.LedgerService/GetObject`
- **Authentication Method:** Header `x-api-key: [REDACTED]`
- **Target Onchain Object:** `0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090` (`MemWalAccount`)
- **JSON-RPC Deprecation Migration:** Sui full nodes deprecated legacy JSON-RPC methods; Tatum provides official HTTP/2 gRPC gateway at `sui-mainnet-grpc.gateway.tatum.io`.
- **Observed Behavior:** HTTP/2 gRPC response received (122 bytes payload, `grpc-status: 0`).
- **Authenticated Sui Call Status:** `true` (PASS)
- **Verified Onchain Identifiers:**
  - **Object ID:** `0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090`
  - **Onchain Transaction Digest:** `HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK`

### Verifiable Connection Between Walrus & Tatum:
Walrus Memory spaces on Sui are anchored by the onchain shared object `MemWalAccount` (and system package `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`). Tatum's Sui gRPC Gateway directly queries this shared `MemWalAccount` object ID via `/sui.rpc.v2.LedgerService/GetObject`, retrieving its live Move object data and latest modifying transaction digest (`HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK`), directly establishing verifiable onchain ledger connectivity between Walrus decentralized memory and Tatum blockchain RPC.

---

## 5. K4: Football Settlement Adjudication Contract

### Test Cases Run:
1. `Arsenal vs Chelsea (2-1)` 1X2 -> Home Win (`WON`) — **PASS**
2. `Arsenal vs Chelsea (2-1)` 1X2 -> Away Win (`LOST`) — **PASS**
3. `Arsenal vs Chelsea (2-1)` 1X2 -> Draw (`LOST`) — **PASS**
4. `Arsenal vs Chelsea (2-1)` BTTS Yes -> (`WON`) — **PASS**
5. `Arsenal vs Chelsea (2-1)` BTTS No -> (`LOST`) — **PASS**
6. `Arsenal vs Chelsea (2-1)` Over 2.5 -> (`WON`) — **PASS**
7. `Arsenal vs Chelsea (2-1)` Under 2.5 -> (`LOST`) — **PASS**
8. `Anytime Goalscorer` -> **UNSUPPORTED_REQUIRES_MANUAL** (Fail-closed) — **PASS**
9. `Match Postponed` -> **PENDING** — **PASS**
10. `Match Cancelled` -> **VOID** — **PASS**

---

## 6. K5: Telegram Authentication Security Protocol

### Security Tests Run:
1. **Valid Fresh Payload:** PASS (Authenticated successfully, user ID extracted).
2. **Tampered User ID:** PASS (HMAC mismatch caught; rejected).
3. **Stale Payload (>24 hours old):** PASS (Freshness check rejected).
4. **Future Timestamp:** PASS (Clock-skew / replay rejected).
5. **Wrong Bot Secret:** PASS (Signature rejected).

---

## 7. Walrus V2 Write Path & Sequence Integration Evidence

### Key Architectural Verifications:
1. **Transactional V2 Sequence Allocation:** Replaced legacy receipt queries with atomic PostgreSQL row-level increments via `allocateNextEventSequence` on table `user_event_sequences`. Sequences are contiguous, strictly monotonic per user, and start at 1. Rollback restores snapshot with 0 consumed sequence numbers.
2. **Format Invariant Enforcement:** Constraint `chk_outbox_format_sequence` enforces that V2 records strictly have `format_version = 2` and `sequence_number > 0`. Unique partial index `uq_memory_outbox_user_seq` prevents duplicate sequence numbers.
3. **Encryption & Key Versioning:** Envelope format `[WWR:v1] [kv:<version>] [analyst:<id>] [type:<event>] [seq:<n>] [enc:<iv>:<tag>:<ciphertext>]`. Fully backward-compatible with legacy envelopes omitting `[kv:...]` (defaulting to version 1). Unknown key versions fail closed.
4. **Worker Idempotency & Reconciliation:** Outbox worker passes `idempotencyKey: item.id` to `@mysten-incubation/memwal`. Before writing to Walrus, worker reconciles against existing `memory_receipts` by `outbox_id` or `(user_id, namespace, sequence_number)` to eliminate duplicate writes and fees.
5. **Non-Blocking Cron Sync:** Scheduled `POST /api/cron/settle` drains outbox and reclaims stale in-flight items without blocking settlement or notification responses.

---

## 8. Phase 6: Tatum Sui Mainnet Onchain Ledger Evidence

### Verified Ledger Query:
- **Date/Time (UTC):** 2026-11-01
- **Gateway Endpoint:** `https://sui-mainnet-grpc.gateway.tatum.io`
- **Transport:** HTTP/2 gRPC
- **RPC Service:** `/sui.rpc.v2.LedgerService/GetObject`
- **Authentication:** `x-api-key: [REDACTED]`
- **Target Object:** `0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090` (Walrus Memory `MemWalAccount`)
- **Query Status:** **CONFIRMED (200 OK / gRPC Status 0)**
- **Response Size:** 122 bytes
- **Onchain Transaction Digest:** `HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK`
- **Protected Endpoint:** `GET /api/tatum/proof` exposes structured onchain proof to authenticated clients with zero API key leakage.

