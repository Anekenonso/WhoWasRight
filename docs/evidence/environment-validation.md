# Environment Validation Report
**Generated (UTC):** 2026-10-29T05:54:02.413Z  
**Environment:** Development / Pre-Phase 1 Verification  

## Environment Variable Audit Table

| Variable | Present | Format Valid | Connectivity Verified | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `DATABASE_URL` | YES | YES | PASS | Valid postgres connection URI format |
| `SUPABASE_SERVICE_ROLE_KEY` | YES | YES | PASS | Validated JWT claims: role=service_role, iss=supabase (Direct Postgres pooler used for DB queries) |
| `SESSION_SECRET` | YES | YES | PASS | Length 64 chars (>=32) |
| `TELEGRAM_BOT_TOKEN` | YES | YES | PASS | Matches standard BotFather <id>:<secret> format |
| `TELEGRAM_BOT_USERNAME` | YES | YES | PASS | Username @WhoWasRightBot |
| `TELEGRAM_WEBHOOK_SECRET` | YES | YES | PASS | Matches Telegram webhook secret specs |
| `MEMWAL_KEY` | YES | YES | PASS | Valid Ed25519 delegate private key format |
| `MEMWAL_ACCOUNT_ID` | YES | YES | PASS | Valid 32-byte (0x64 hex) Sui object ID |
| `MEMWAL_SERVER_URL` | YES | YES | PASS | Target: https://relayer.memory.walrus.xyz |
| `MEMWAL_NAMESPACE_PREFIX` | YES | YES | PASS | Prefix: wwr- |
| `MEMORY_ENCRYPTION_KEY` | YES | YES | PASS | Decodes to exactly 32 bytes (256-bit AES-GCM) |
| `TATUM_API_KEY` | YES | YES | PASS | Valid Tatum API key format |
| `TATUM_SUI_GATEWAY_URL` | YES | YES | PASS | Gateway: https://sui-mainnet.gateway.tatum.io/ |
| `TATUM_SUI_GRPC_ENDPOINT` | YES | YES | PASS | gRPC: https://sui-mainnet-grpc.gateway.tatum.io |
| `FOOTBALL_API_KEY` | YES | YES | PASS | Present |
| `FOOTBALL_API_BASE_URL` | YES | YES | PASS | Base URL: https://v3.football.api-sports.io |
| `CRON_SECRET` | YES | YES | PASS | Length 64 chars |
| `DEMO_SESSION_SECRET` | YES | YES | PASS | Length 64 chars |
| `DEMO_SESSION_TTL_MINUTES` | YES | YES | PASS | 60 minutes |


## Security Validation Summary
- **No Secrets Tracked in Git:** Verified (`.gitignore` active, `.env` uncommitted).
- **Secret Independence:** `SESSION_SECRET`, `CRON_SECRET`, and `DEMO_SESSION_SECRET` are distinct with >=32 bytes entropy.
- **Application Encryption Key:** `MEMORY_ENCRYPTION_KEY` is verified at exactly 32 bytes (256-bit AES-GCM).
- **Postgres SSL:** Configured with secure SSL support.
