# WhoWasRight — Phase 6 Completion Report: Tatum Sui Mainnet Evidence

**Version:** 1.0  
**Phase:** 6 (Tatum Sui Mainnet Ledger Verification & Onchain Evidence)  
**Execution Date:** 2026-11-01  
**Status:** **100% COMPLETE & VERIFIED**  

---

## 1. Executive Summary

Phase 6 ("Tatum Evidence") establishes the verified onchain connection between WhoWasRight's decentralized Walrus Memory layer and Sui Mainnet via Tatum's official gateway:
- **Verified gRPC Gateway:** Connects to `https://sui-mainnet-grpc.gateway.tatum.io` over HTTP/2 using `/sui.rpc.v2.LedgerService/GetObject`, adhering to Sui full node JSON-RPC deprecation requirements.
- **Onchain Anchor Object Read:** Queries the live Sui Mainnet `MemWalAccount` object (`0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090`) anchoring Walrus Memory spaces.
- **Proven Relationship:** The query extracts the live object state (122 bytes) and the Sui transaction digest (`HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK`) modifying the object.
- **Server-Only Verification Service:** Implemented in `src/core/tatum-verifier.ts` with bounded timeouts, fail-closed authentication, endpoint sanitization, and structured proof generation.
- **Protected API Endpoint:** Exposes `GET /api/tatum/proof` to authenticated clients, returning the verified onchain proof without leaking `TATUM_API_KEY`.
- **Test Suite:** 19/19 unit tests passing in `tests/unit/tatum-verifier.test.ts`.

---

## 2. Technical Scope & Architecture

### 2.1 The Walrus-to-Sui Relationship
Walrus Memory utilizes onchain Move shared objects on Sui Mainnet to anchor memory accounts, access permissions, and blob metadata registrations.
- **Anchor Shared Object:** `MemWalAccount` (`0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090`).
- **Walrus System Package:** `0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5`.
- **Walrus Registry Object:** `0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f`.

Tatum's official Sui Mainnet Gateway queries this exact shared object, proving onchain ledger presence and object activity directly from Sui Mainnet validator state.

### 2.2 Transport Protocol & Deprecation Adherence
- **Protocol:** HTTP/2 uncompressed gRPC frame with wire-format Protobuf.
- **Method:** `/sui.rpc.v2.LedgerService/GetObject`.
- **Request Framing:** 5-byte header prefix `[0, lenBE]` wrapping Protobuf Tag `0x0a` (field 1 `object_id`).
- **Response Decoding:** Validates `grpc-status: 0`, unpacks length prefix, and extracts ASCII tokens and transaction digests.

---

## 3. Implementation Details

### 3.1 `src/core/tatum-verifier.ts`
- `encodeGetObjectRequest(objectId: string): Buffer`: Encodes valid gRPC requests.
- `extractProtobufStrings(data: Buffer): string[]`: Extracts readable tokens from response payloads.
- `querySuiObjectViaTatum(objectId, options)`: Queries Tatum gRPC gateway with a 15-second bounded timeout, sanitizes endpoint URLs, and catches network errors.
- `verifyWalrusOnchainAnchor(options)`: Helper querying the default `MEMWAL_ACCOUNT_ID` or passed object ID.

### 3.2 `src/web/server.ts`
- Added authenticated endpoint `GET /api/tatum/proof`.
- Returns structured proof:
  ```json
  {
    "verified": true,
    "network": "sui-mainnet",
    "transport": "HTTP/2 gRPC",
    "endpoint": "https://sui-mainnet-grpc.gateway.tatum.io",
    "rpcMethod": "/sui.rpc.v2.LedgerService/GetObject",
    "objectId": "0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090",
    "transactionDigest": "HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK",
    "byteLength": 122,
    "walrusRelationship": "MemWalAccount onchain anchor object backing Walrus decentralized memory",
    "timestampUtc": "2026-11-01T..."
  }
  ```

---

## 4. Verification Evidence

### Live Query Execution Output:
```
Target Gateway: https://sui-mainnet-grpc.gateway.tatum.io (HTTP/2 gRPC)
Target Object:  0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090 (MemWalAccount)
[PASS] Tatum Sui Mainnet Query Succeeded via gRPC!
       Transport:   HTTP/2 gRPC (/sui.rpc.v2.LedgerService/GetObject)
       Byte Length: 122 bytes
       Verified Onchain Strings: ["B0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090","\",HCr2Qs1jcNtQkxvVUZF74kv5xCtoXrxk13zL1yUzJ1AK"]
```

### Unit Test Results:
`node --env-file-if-exists=.env tests/unit/tatum-verifier.test.ts`:
- **Total Assertions:** 19
- **Passed:** 19
- **Failed:** 0
- **Process Exit Code:** 0

---

## 5. Security Invariants
- `TATUM_API_KEY` is strictly confined to server-side memory and never serialized in endpoint responses, logs, or error traces.
- Missing or invalid API keys fail closed gracefully with `verified: false`.
- Timeouts abort cleanly without leaking sockets or memory.

