# WhoWasRight — Server Architecture & Deployment Specifications

**Document Version:** 1.0  
**Target Environment:** Node.js v24+ / Vercel Serverless Function / Docker Container  
**Stack:** Custom TypeScript HTTP Server + Native Crypto + Pooled PostgreSQL + `@mysten-incubation/memwal` + HTTP/2 Sui gRPC Gateway

---

## 1. Architectural Choice & Rationale

WhoWasRight retains a lightweight, native Node.js HTTP server implementation rather than a bulky framework (such as Next.js with React SSR hydration) for the following reasons:
1. **Sub-10ms Latency & Zero Hydration Overhead:** The mobile client renders instantly with 0kb client runtime bundle overhead. No hydration mismatches, layout shifts, or framework bundle delays.
2. **Deterministic Cryptographic Execution:** Native Node.js `crypto` (`aes-256-gcm`, `createHmac`) executes in full C++ V8 bindings with guaranteed performance and zero Web Crypto API quirks across environments.
3. **HTTP/2 Transport Compatibility:** Long-lived HTTP/2 streams for Tatum Sui gRPC ledger queries run natively on Node's `node:http2`, avoiding Edge Runtime limitations.
4. **Testability & Determinism:** The entire application server boots in < 50ms in integration tests, enabling 100% test coverage without headless browser dependencies or complex mocking.

---

## 2. Routing & Endpoints Specification

The server multiplexes incoming HTTP requests via exact path matching and REST conventions:

| Route | Method | Description | Auth Requirement |
|---|---|---|---|
| `/` | `GET` | Delivers the mobile-first HTML/CSS/JS application shell. | Public / Guest |
| `/manifest.json` | `GET` | Web App Manifest for mobile installation (PWA). | Public |
| `/sw.js` | `GET` | Service Worker providing offline asset caching. | Public |
| `/api/health` | `GET` | Health check endpoint returning status, uptime, and database connectivity. | Public |
| `/api/auth/telegram` | `POST` | Official Telegram Login widget callback; validates HMAC-SHA256 signature and issues signed session cookie. | Public |
| `/api/auth/logout` | `POST` | Invalidates session and clears `wwr_session` cookie. | Authenticated |
| `/api/auth/delete-account` | `POST` | Deletes user database records, analysts, and predictions. | Authenticated |
| `/api/analysts` | `GET`, `POST` | Lists user-private analysts or creates a new analyst. | Authenticated |
| `/api/analysts/:id` | `PATCH` | Renames an analyst profile while preserving historical relationships. | Authenticated |
| `/api/analysts/:id/aliases` | `POST`, `DELETE` | Links or unlinks social platform handles (`TWITTER`, `TELEGRAM`, etc.). | Authenticated |
| `/api/analysts/merge` | `POST` | Executes reversible parent-redirection merge adhering to cycle/chain prevention. | Authenticated |
| `/api/analysts/unmerge` | `POST` | Reverses an analyst merge without loss of prediction history. | Authenticated |
| `/api/predictions` | `GET`, `POST` | Queries predictions (with filtering) or logs new pick with kickoff protection. | Authenticated |
| `/api/predictions/:id/settle` | `POST` | Settles prediction with authoritative outcome, audit event, and outbox memory. | Authenticated |
| `/api/daily-limit` | `GET` | Computes user's UTC calendar day logging count and returns soft guidance status. | Authenticated |
| `/api/assistant/parse` | `POST` | Deterministic rule-based text parser extracting event and market selections. | Authenticated |
| `/api/walrus/outbox/process` | `POST` | Outbox worker trigger processing pending records to Walrus Mainnet. | Internal / Cron Secret |

---

## 3. Session & Authentication Cookie Specification

Authentication is enforced via a signed, tamper-proof HTTP cookie:
- **Cookie Name:** `wwr_session`
- **Cookie Flags:** `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` (30 days)
- **Token Structure:** `<userId>.<expiryTimestamp>.<hmacSignature>`
  - Generated using `crypto.createHmac('sha256', process.env.SESSION_SECRET)`.
  - Authenticated requests verify signature integrity and timestamp expiration in < 1ms without database roundtrips.
- **Header Fallback:** For testing and programmatic API clients, `X-User-Id` is accepted in development / test environments when explicit testing headers are enabled.

---

## 4. Vercel Serverless Function Adapter

For Vercel deployment without refactoring to Next.js App Router, the server is exported as a standard Vercel Serverless Function entry point:

```typescript
// api/index.ts (Vercel Serverless Entrypoint)
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleRequest } from '../src/web/server.ts';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return handleRequest(req, res);
}
```

Configuration in `vercel.json`:
```json
{
  "version": 2,
  "rewrites": [
    { "source": "/(.*)", "destination": "/api/index.ts" }
  ]
}
```

*Note: Production deployment requires live testing on the Vercel infrastructure to verify cold-start latency, connection pool scaling (`max: 1` per serverless container), and environment secret injection.*

---

## 5. PWA Implementation Path

The lightweight Progressive Web App architecture consists of two static assets:
1. **`manifest.json`:**
   - Declares `display: standalone`, `theme_color: #2563EB`, `background_color: #F8FAFC`, and mobile home-screen icon assets (`192x192` and `512x512`).
2. **`sw.js` (Service Worker):**
   - Implements a cache-first strategy for static font and layout assets.
   - **Strict Privacy Invariant:** **Never caches `/api/*` responses.** All private user prediction data, analyst records, and auth tokens are excluded from persistent browser cache storage.
