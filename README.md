# WhoWasRight

**A private sports prediction journal with verifiable proof of who called it right.**

WhoWasRight allows sports bettors and enthusiasts to track tipsters and personal predictions with complete accountability. By separating API-verified outcomes from self-reported claims, enforcing pre-kickoff logging immutability, and anchoring proof on decentralized storage, WhoWasRight eliminates hindsight bias and faked betting records.

---

## Try the Live App

Judges, evaluators, and visitors can immediately test the live application without needing a Telegram account.

* **Live Deployment:** [https://whowasright.onrender.com/](https://whowasright.onrender.com/)

### Quick Start with a Demo Account
1. Open [https://whowasright.onrender.com/](https://whowasright.onrender.com/).
2. On the sign-in screen, click **"Log in with a demo account"** below the Telegram login widget.
3. You will immediately enter an isolated sandbox session initialized with sample data.
4. **Explore core journeys:**
   - **Analyst Profiles & Credibility:** Inspect track records for seeded tipsters (e.g., *Jamie Carragher*, *Gary Neville*), reviewing their settled records, decisive win rates, and rating tiers (*Good*, *Average*, *Poor*, *Not Rated*).
   - **View Predictions:** Filter through active pending picks and settled outcomes.
   - **Log a Prediction:** Use the manual pick form or paste assistant to log a new prediction before match kickoff.
   - **Manual Settlement Flow:** Settle pending predictions and observe how credibility scores update deterministically.
   - **Merge Analysts:** Test profile merging and unmerging across aliases.

### Demo Sandbox & Isolation Model
- **60-Minute Session TTL:** Demo sessions are active for 60 minutes.
- **Strict Data Isolation:** Demo accounts use negative identifiers (`telegram_id < 0`) and operate on isolated records. Demo activity cannot view, modify, or leak into real user accounts.
- **Automatic Cleanup:** Expired demo sessions and their associated sandbox data are automatically purged during periodic maintenance cycles without affecting real user records.

---

## Core Features

- **Immutable Kickoff Enforcement:** Predictions can only be recorded or edited before match kickoff UTC. Once a match starts, the pick is locked.
- **Cryptographic Credibility Engine:**
  - Separates **API-verified** match results from self-reported outcomes.
  - Requires a minimum of 6 decisive settled picks before assigning a performance tier (*Good*, *Average*, *Poor*).
  - Pushes and voids are tracked transparently without skewing win rates.
- **Analyst Alias & Merge System:**
  - Track tipsters across multiple platforms (Telegram handles, Twitter/X).
  - Merge duplicate analyst records with full auditability and reversible unmerges.
- **Quick Paste Assistant:** Rapidly extracts event, market, pick, and kickoff time from unstructured betting copy or social posts.
- **Telegram Bot & Result Alerts:** Connects via Telegram Login to deliver automated result notifications and settlement reminders.
- **Decentralized Storage Proofs:** Anchors historical credibility and prediction records to Walrus Mainnet storage blobs.

---

## Technology Stack

- **Runtime:** Node.js (v22.18+ / v24+) with native TypeScript execution
- **Server:** Native Node.js HTTP server (zero client bundle, sub-10ms response times)
- **Database:** PostgreSQL (with pooled connection management and automated SQL migrations)
- **Decentralized Storage:** Walrus Mainnet (`@mysten-incubation/memwal`)
- **Ledger Verification:** Tatum HTTP/2 Sui gRPC Gateway
- **Frontend:** Lightweight, accessible mobile-first responsive web client (no hydration delays)

---

## Running Locally

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
# Run complete test suite
npm test

# Run isolated unit tests
npm run test:unit:credibility
npm run test:unit:telegram
npm run test:unit:daily
node --env-file-if-exists=.env tests/unit/demo-cleanup.test.ts
```

---

## Verified Sponsor Integrations & Mainnet Proofs

WhoWasRight integrates **Walrus Memory** and **Tatum Sui Gateway** with authentic onchain proofs on Sui Mainnet:

### 1. Walrus Mainnet Decentralized Memory (`@mysten-incubation/memwal`)
- **Relayer:** `https://relayer.memory.walrus.xyz` (Production Mainnet)
- **Top-K Vector Lossiness Mitigation:** Solved the semantic truncation dilemma by wrapping events in structured hybrid envelopes with application-layer AES-256-GCM encryption and maintaining deterministic sequence replay.
- **Confirmed Memory Writes:** Exceeds the hackathon minimum with **70+ confirmed Mainnet memories** (and 13 fully traced audit events documented in [`docs/evidence/walrus-history-proof.json`](docs/evidence/walrus-history-proof.json)).
- **Sample Mainnet Confirmations:**
  - `Job ID: 6d7f7793-67e0-4d42-83dd-a213638347d7` | `Blob ID: h4TO8psqwWt64eTII2stzdg1g9YtCEE5Nb9iiQMjAbY`
  - `Job ID: f52d8f6d-356a-475d-90b1-54944b18836b` | `Blob ID: mYtp2vRSDUfjTAMoKjO4x07AgqKVDn-Yv5h-dpWiw9M`
  - `Job ID: ef6047e5-3ea4-4c8e-8e0f-86021bab7a37` | `Blob ID: COsYDP2FMryO9xuy4nOD70IzCWVmPnYGmRd1RuHIhw8`

### 2. Tatum Sui Mainnet Gateway (HTTP/2 gRPC)
- **Gateway Endpoint:** `https://sui-mainnet-grpc.gateway.tatum.io`
- **Method:** `/sui.rpc.v2.LedgerService/GetObject`
- **Onchain Anchor Object:** Queries the live Move shared object `MemWalAccount` (`0xc2225f53b9cb17f56253766942908c2ebb41c1e99dfecb774bb182e3e9841090`) anchoring Walrus memory spaces.
- **Live Proof Endpoint:** Authenticated clients can inspect live onchain validator proof directly via `GET /api/tatum/proof`.
- **Detailed Integration Report:** See [`docs/INTEGRATION_PROOFS.md`](docs/INTEGRATION_PROOFS.md) and [`docs/PHASE_6_REPORT.md`](docs/PHASE_6_REPORT.md).

---

## Security & Architecture

- **Session Security:** Bearer token authentication with HMAC-SHA256 signature verification and cryptographically random session tokens.
- **Sensitive Data Isolation:** Demo mode accounts are strictly partitioned by negative Telegram IDs (`telegram_id < 0`), ensuring demo sessions cannot interact with production user journals.
- **Replay & Tamper Defense:** Telegram authentication payloads are HMAC-SHA256 verified against the configured bot secret with a strict 24-hour timestamp check.
- **Outbox Concurrency & Rate Safety:** Bounded batch processing prevents gateway timeouts while ensuring reliable asynchronous memory delivery.


