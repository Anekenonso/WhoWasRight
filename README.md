<div align="center">

# WhoWasRight 🎯

**Private sports prediction journal with cryptographically immutable credibility tracking.**

[![Live Demo](https://img.shields.io/badge/Live_App-whowasright.onrender.com-10B981?style=for-the-badge&logo=render&logoColor=white)](https://whowasright.onrender.com/)
[![Walrus Mainnet](https://img.shields.io/badge/Decentralized_Storage-Walrus_Mainnet-00E5FF?style=for-the-badge&logo=icloud&logoColor=black)](https://relayer.memory.walrus.xyz)
[![Tatum Sui Gateway](https://img.shields.io/badge/Onchain_Gateway-Tatum_Sui_gRPC-3B82F6?style=for-the-badge&logo=blockchaindotcom&logoColor=white)](https://sui-mainnet-grpc.gateway.tatum.io)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-Passing_100%25-10B981?style=flat-square&logo=githubactions&logoColor=white)](tests/)
[![Security](https://img.shields.io/badge/Security-HMAC--SHA256_|_AES--256--GCM-F59E0B?style=flat-square&logo=auth0&logoColor=white)](#security--architecture)
[![Hindsight Blocked](https://img.shields.io/badge/Audit-Hindsight_Proof_100%25-10B981?style=flat-square&logo=cloudflare&logoColor=white)](#core-features)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)

</div>

---

### 🏆 Total Recall Hackathon Quick Links
> **Track 01:** Markets & Sports Prediction  
> **Live Production App:** [https://whowasright.onrender.com/](https://whowasright.onrender.com/)  
> **Sponsor Technologies:** Walrus Decentralized Memory (`@mysten-incubation/memwal`) & Tatum Sui Gateway (HTTP/2 gRPC)

---

## ⚡ Live Demo & Quick-Start (Instant Sandbox Access)

Anyone can test the live production application immediately without needing a Telegram account or Web3 wallet:

1. **Open the Live App:** [https://whowasright.onrender.com/](https://whowasright.onrender.com/)
2. **One-Click Sandbox Login:** Below the Telegram login widget, click **"Log in with a demo account"**.
3. **Explore the 3 Core Validation Journeys:**
   - **📊 Tipster Credibility Scorecards:** Inspect seeded analysts (*Jamie Carragher*, *Gary Neville*). View their decisive win rates, push/void separation, and calibrated tiers (*Platinum / Good / Average / Poor*).
   - **🔒 Pre-Kickoff Lock Engine:** Attempt to log a prediction using the manual form or **AI Paste Assistant**. Observe that once a match starts (UTC boundary), retroactive logging or editing is permanently fail-closed.
   - **⛓️ Live Onchain Validator Proof:** Call `GET /api/tatum/proof` (or inspect Settings) to view live cryptographic proof of the Sui Mainnet transaction digest anchoring the user's Walrus memory space.

*Note: Demo accounts operate in an isolated sandbox (`telegram_id < 0`) with a 60-minute TTL and automatic periodic cleanup. Real user accounts and production ledgers are strictly partitioned.*

---

## 📋 Hackathon Evidence & Sponsor Proof Map

| Dimension / Category | Requirement | **WhoWasRight Implementation** | Direct Proof Reference |
| :--- | :--- | :--- | :--- |
| **Walrus Mainnet Memory** | $\ge 10$ confirmed Mainnet memories | **70+ confirmed Mainnet memories** recorded on production Walrus relayer (`relayer.memory.walrus.xyz`) | [`docs/evidence/walrus-history-proof.json`](docs/evidence/walrus-history-proof.json) |
| **Decentralized Reconstruction** | Real memory recall & ledger reconstruction | **Solved the Top-K Vector Truncation Flaw:** Built a deterministic sequence ledger with AES-256-GCM encryption guaranteeing 100% win-rate reconstruction without losing events | [`docs/evidence/walrus-v2-lifecycle-report.md`](docs/evidence/walrus-v2-lifecycle-report.md)<br>[`src/core/walrus-reconstruction.ts`](src/core/walrus-reconstruction.ts) |
| **Tatum Sui Gateway** | Meaningful Sui Mainnet read via Tatum Gateway | Queries the live Move shared object `MemWalAccount` (`0xc2225f53...`) via HTTP/2 gRPC (`/sui.rpc.v2.LedgerService/GetObject`) | Live endpoint: `GET /api/tatum/proof`<br>[`src/core/tatum-verifier.ts`](src/core/tatum-verifier.ts) |
| **Automated Settlement** | Deterministic match adjudication | Automated football API adjudication (1X2, BTTS, O/U) with strict postponement/void handling | [`docs/evidence/sponsor-kill-tests.md`](docs/evidence/sponsor-kill-tests.md) |
| **Audit Reports** | Complete technical audit trail | Verified reports for all technical kill-tests (K1–K5) and architecture stages | [`docs/PHASE_6_REPORT.md`](docs/PHASE_6_REPORT.md)<br>[`docs/INTEGRATION_PROOFS.md`](docs/INTEGRATION_PROOFS.md) |

---

## 🎯 The Problem WhoWasRight Solves

In the $100B+ sports prediction and tipster industry, **hindsight tampering is rampant**:
- **Fake 10-0 Heaters:** Social media tipsters crop screenshots and alter HTML inspection elements.
- **Disappearing Losses:** Unfavorable betting slips are quietly deleted minutes after full-time.
- **Retroactive Edits:** Predictions are edited during the 80th minute to match current scorelines.

**WhoWasRight solves this with mathematical finality:**
1. **Cryptographic Kickoff Locks:** A pick cannot be created, edited, or deleted once match kickoff UTC passes.
2. **Decentralized Audit Proofs:** Predictions and settlements are anchored to **Walrus Mainnet** storage blobs. Even if our database were wiped, an analyst’s entire credibility history can be deterministically reconstructed from decentralized storage.
3. **API-Verified Separation:** Self-reported wins are segregated from official sports API results.

---

## 🚀 Core Features

- **Immutable Kickoff Enforcement:** Predictions can only be recorded before match kickoff UTC. Once started, the pick is frozen forever.
- **Cryptographic Credibility Engine:**
  - Separates **API-verified** match results from self-reported claims.
  - Requires a minimum of 6 decisive settled picks before assigning a performance tier (*Good*, *Average*, *Poor*).
  - Pushes and voids are separated transparently without skewing win rates.
- **Analyst Alias & Merge System:**
  - Track tipsters across multiple platforms (Telegram handles, Twitter/X).
  - Merge duplicate analyst records with full auditability, cycle prevention, and zero-loss reversible unmerges.
- **AI / Text Paste Assistant:** Rapidly extracts event, market, pick, and kickoff time from unstructured betting copy or social posts with zero manual data entry.
- **Telegram Bot & Result Alerts:** Connects via Telegram Login to deliver automated result notifications and settlement reminders.
- **Decentralized Storage Proofs:** Anchors historical credibility and prediction records to Walrus Mainnet storage blobs (`@mysten-incubation/memwal`).

---

## 🛠️ Technology Stack

- **Runtime:** Node.js (v22.18+ / v24+) with native TypeScript execution
- **Server:** Native Node.js HTTP server (zero client bundle, sub-10ms response times)
- **Database:** PostgreSQL (with pooled connection management and automated SQL migrations)
- **Decentralized Storage:** Walrus Mainnet (`@mysten-incubation/memwal`)
- **Ledger Verification:** Tatum HTTP/2 Sui gRPC Gateway
- **Frontend:** Lightweight, accessible mobile-first responsive web client (no hydration delays)

---

## 💻 Running Locally

### Prerequisites
- Node.js >= 22.18.0
- PostgreSQL database instance

### Environment Variables
Create a `.env` file based on `.env.example`:
```bash
PORT=3000
DATABASE_URL=postgresql://user:password@localhost:5432/whowasright
TELEGRAM_BOT_NAME=YourBotUsername
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
SESSION_SECRET=your_32_byte_secret_key
ENCRYPTION_KEY=your_32_byte_aes_key
MEMWAL_KEY=your_walrus_key
MEMWAL_ACCOUNT_ID=your_walrus_account_id
TATUM_API_KEY=your_tatum_key
```

### Installation & Startup
```bash
# Install dependencies
npm install

# Run database migrations
npm run migrate

# Start local server
npm start
```
The server will start at `http://localhost:3000`.

### Running Tests
```bash
# Run Walrus V2 decentralized lifecycle & reconstruction verification
npm run test:walrus:lifecycle

# Run complete test suite
npm test

# Run isolated unit tests
npm run test:unit:credibility
npm run test:unit:telegram
npm run test:unit:daily
node --env-file-if-exists=.env tests/unit/demo-cleanup.test.ts
```

---

## 🔒 Security & Architecture

- **Session Security:** Bearer token authentication with HMAC-SHA256 signature verification and cryptographically random session tokens.
- **Sensitive Data Isolation:** Demo mode accounts are strictly partitioned by negative Telegram IDs (`telegram_id < 0`), ensuring demo sessions cannot interact with production user journals.
- **Replay & Tamper Defense:** Telegram authentication payloads are HMAC-SHA256 verified against the configured bot secret with a strict 24-hour timestamp check.
- **Outbox Concurrency & Rate Safety:** Bounded batch processing with `SKIP LOCKED` prevents gateway timeouts while ensuring reliable asynchronous memory delivery.
- **Application-Layer Encryption:** Sensitive bet details are encrypted with AES-256-GCM before transmission to decentralized storage.

---

## 📜 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
