# Sponsor Kill-Tests Evidence Report
**Generated (UTC):** 2026-10-29T05:54:02.413Z  
**Walrus Network:** Mainnet (`https://relayer.memory.walrus.xyz`)  
**Tatum Sui Network:** Sui Mainnet (`https://sui-mainnet.gateway.tatum.io/`)  

---

## 1. Walrus Memory Mainnet Verification

### Live Relayer Probes
- **Relayer Status:** `HEALTHY (write_ready: true)`
- **Network Mode:** Production Mainnet
- **Onchain Anchors:**
  - Package ID: `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`
  - Registry ID: `0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f`

### Authenticated Mainnet Write & Recall
- **Job ID:** `fe32a9e0-dedd-4da4-a671-4ebf7981784d`
- **Blob ID:** `6UebqOcTznMbK0RMa0o7Q6ORnthBzcjLcI_ycGyDwsY`
- **Write Confirmed via `waitForRememberJob`:** `true`
- **Actual Semantic Recall via `memwal.recall()`:** `true`
- **Namespace Isolation Tested:** `true`
- **Namespace Restore Tested:** `true`

### Encryption Compatibility Kill-Test
- **AES-256-GCM Envelope Encryption:** Supported
- **Decrypted Byte-for-Byte Consistency:** `true`
- **Wrong Key Rejection:** `true` (Authentication tag fails closed)
- **Tampered Ciphertext Rejection:** `true` (Authentication tag fails closed)

---

## 2. Tatum Sui Mainnet Verification

### Gateway Health & Authentication
- **Transport:** HTTP/2 gRPC (`/sui.rpc.v2.LedgerService/GetObject`)
- **Endpoint:** `https://sui-mainnet-grpc.gateway.tatum.io`
- **Authentication:** Verified via `x-api-key` (401 gate verified on bad key)
- **JSON-RPC Notice:** Sui full nodes deprecated legacy JSON-RPC methods; Tatum provides official HTTP/2 gRPC gateway.

### Sponsor Integration Link
- **User MemWalAccount Object Lookup:** `CONFIRMED`
- **Object Metadata Excerpt (Retrieved via Tatum gRPC):**
```json
{
  "objectId": "0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090",
  "byteLength": 122,
  "detectedStrings": [
    "B0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090",
    "\",HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK"
  ]
}
```
- **Proven Relationship:** The user's `MemWalAccount` shared object on Sui anchors their Walrus Memory space. Tatum's Sui gRPC Gateway directly queries this shared object ID, retrieving its live Move object data and transaction digest.

---

## 3. Negative & Failure Testing Evidence

| Test Scenario | Expected Outcome | Actual Outcome | Status |
| :--- | :--- | :--- | :--- |
| Invalid Database Credentials | Fail-closed / Rejected | Connection rejected as expected (fail-closed) | PASS |
| Invalid Telegram Token | Fail-closed / Rejected | Rejected with HTTP 401 | PASS |
| Invalid Tatum API Key | Fail-closed / Rejected | Rejected with HTTP 401 Unauthorized | PASS |
| Unsupported Football Market Rejection | Fail-closed / Rejected | Market rejected from auto-settlement; flagged for manual user adjudication | PASS |
| Tampered Encrypted Memory Decryption | Fail-closed / Rejected | Decryption throws authentication error when ciphertext byte is altered | PASS |
| Wrong Application Encryption Key | Fail-closed / Rejected | Decryption throws authentication error when different 256-bit key is used | PASS |
