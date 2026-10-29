# WhoWasRight | Total Recall Agent Build Plan
**Version:** 1.1 | **Research checked:** 28 October 2026 | **Deadline:** 10 November 2026, 17:00 UTC
**Mission:** Ship a private, premium, mobile-first sports prediction journal that remembers which voices were right **for each user**. Win on a real Walrus Memory learning loop, demonstrated Tatum Sui reads, reliable settlement, and a frictionless live demo. No placement is guaranteed.

## 0. NON-NEGOTIABLE HACKATHON GATES
- **Track:** 01 Markets & Sports Prediction. The project fits the official *pick journal / post-game scorecard / track which voices were right* examples. Do not claim bookmaker odds or onchain odds comparisons; these are in the track brief but are not an explicit universal submission requirement.
- **Walrus:** real **Mainnet** `remember` writes, **at least 10 confirmed memories**; real `recall` in the live app; store proof (job IDs, confirmations, timestamps, redacted logs). No staging-only or fake memory counts.
- **Tatum:** successful real **Sui Mainnet** queries through a Tatum gateway; prove use with request method, response excerpt, transaction/object IDs where applicable, and documented relation to Walrus. A generic chain-height widget is insufficient as a product integration.
- **Deliverables:** working deployed app; public GitHub repo; published blog explaining product, Walrus + Tatum use and how it learned over time; **2-3 minute** video; official submission form. Only **one submission per person**.
- **Submission details to prepare:** Discord handle, discovery source, first Web3 project answer, Tatum ID, SUI address, SUI account ID, `MEMWAL_AGENT_ID` (clarify form terminology versus SDK `MEMWAL_ACCOUNT_ID`), project description, video URL, repo URL, Walrus experience, Tatum AI Builder experience. Optional AI Builder bonus **only if genuinely built primarily with it**; do not misrepresent.
- **Judging:** sponsor integration 30%, technical quality 30%, creativity 20%, presentation 20%. Social sharing may earn discretionary bonus; publish only after working proof.

## 1. LOCKED PRODUCT; DO NOT EXPAND SCOPE
**Identity:** light-themed, premium typography and spacing, mobile-first responsive web app with lightweight PWA; no app store, web push, fixture feed, charts, news, public profiles, betting advice, wallets, email or LLMs.
**Auth:** Telegram-only sign-in for real accounts, server-validated Telegram identity, secure session; bot activation optional, notifications on after user starts bot; no email collection. A Telegram ID is personal data. No account recovery other than original Telegram account. **Judge demo is a separate anonymous, isolated, temporary sandbox, not a real user-account login bypass.**
**Screens:** Home (pending/settled, recent picks, analyst preview, primary Log button); Log (sport, event, date/time, analyst, pick, save/add another); Predictions (All/Pending/Settled); Analysts (ratings, history, identities); Prediction/Analyst detail; Settings (bot, privacy/delete, sign-out). Four bottom-nav tabs.
**Picks:** any sport manually; football-only automatic verification. Supported automatic markets initially: **1X2, both-teams-to-score, total goals** only where full-time evidence and exact settlement rules exist. Anything unsupported is user-settled. Rule-based paste parsing only, always review/confirm. Multiple distinct picks per analyst/match; reject exact duplicates.
**Lock:** reject creates/edits/deletes at or after start on server; football requires verified event identity/status/kickoff; other sports use user-entered time and show user-reported timing. Never imply independently proven timing for manual events. Once event has started, rescheduling cannot reopen entry. Archive only after start; archive never removes historical stats.
**Settlement:** only API evidence with complete exact criteria OR explicit user choice. Never infer goalscorers from scores. API downtime => pending/retry then Telegram manual prompt. Auto-settle => Telegram message stating evidence (e.g., full-time score) plus deep link; unsupported criteria => buttons Won/Lost/Push and deep link. No Telegram entry flow or weekly digest.
**Status:** postponed=pending; cancelled=void; abandoned=pending pending authoritative final status; unknown=pending; rescheduled preserve locked state if previously live. Corrections allowed for self-reported results, append audit event; API-settled outcomes can be flagged for review, not silently overwritten.
**Analysts:** user-private linked multi-platform handles, reversible merges, unique internal ID; credibility card at log time. **Rating eligibility:** >=6 settled (W/L/Push), at least 1 decisive result; win rate = W/(W+L). Good >=65%; Average >=45% and <65%; Poor <45%; otherwise Not Rated. Push counts toward eligibility, not denominator; Void/Pending excluded. History badges: 0-5 Insufficient; 6-19 Limited; 20-49 Growing; 50+ Established. Display API-verified vs self-reported separately. Multiple picks from one match count individually.
**Daily limit:** soft warning at pick 16, never block; 25/day is advisory. User can delete account; disclose limits to immutable/onchain records; never promise erasure not proven possible.

## 2. STACK / BOUNDARIES
- **Monorepo:** Next.js App Router + TypeScript + Tailwind + simple accessible UI components; API via Next.js server routes, Node runtime (avoid Edge for crypto/SDK). Supabase Postgres + migrations and RLS, **not Supabase email Auth**. Vercel web/API. One scheduled job on a supported scheduler (e.g. Vercel Cron or GitHub Actions calling authenticated endpoint). Telegram Bot API via webhook with secret verification. A single selected football data provider; document coverage and limits. Optional Redis only if proven necessary; prefer Postgres work queues.
- **Data model (minimum):** users(id,telegram_id unique,notifications_enabled,deleted_at); analysts(id,user_id,name); analyst_aliases(id,analyst_id,platform,handle); events(id,user_id,sport,label,api_fixture_id nullable,start_at_utc,source,ever_started,status); predictions(id,user_id,event_id,analyst_id,market,selection,raw_text nullable,created_at_utc,outcome,verification,archived_at); outcome_events(id,prediction_id,old,new,source,evidence_json,created_at); memory_outbox(id,user_id,event_key,payload,status,attempts,next_retry_at,walrus_job_id); memory_receipts(id,user_id,namespace,job_id,proof_reference,confirmed_at); bot_links(user_id,telegram_chat_id,enabled); sessions (hashed opaque tokens, expiry). Enforce ownership at *all* queries and through RLS; admin/service token server-only.
- **Walrus:** `@mysten-incubation/memwal` official TS SDK; relayer `https://relayer.memory.walrus.xyz`; dedicated developer account + delegated key; per-user random namespace, e.g. `wwr-<internal-uuid>`. `MemWal.create({key,accountId,serverUrl,namespace})`; `health`, `remember`, `waitForRememberJob`, `recall`, `restore`. Source docs identify a memory-space boundary of owner + namespace + app ID. With a shared owner, **backend authorization and cryptographic confidentiality are mandatory**.
- **Tatum:** server-only API key; use **Sui gRPC** when supported, as Tatum documents JSON-RPC depreciation and gRPC migration. Query real Sui transaction/object/owner evidence related to Walrus Memory registration or blob metadata, *only after discovering the exact reference through SDK/contract*. Do not hardcode fictional calls or assume a memory job ID is a transaction digest. If no meaningful mapping is exposed, use minimal auditable Sui onchain hash commitment with documented real transaction and Tatum readback, subject to kill-test.

## 3. CRITICAL KILL-TESTS BEFORE UI WORK (MAX 1 DAY)
**K1 - Walrus Mainnet:** Obtain legitimate account/delegate credentials; run `health`, write **one** non-sensitive test memory; await job confirmation, recall; prove namespace isolation with two internal users; test `restore`. Save redacted proof. Pass only on actual Mainnet success.
**K2 - Privacy versus memory:** Official relayer embeds plaintext before Seal encryption. Encrypting entire content with AES-256-GCM **before** `remember` defeats meaningful semantic recall. Test whether structured retrieval with unique non-secret searchable tags + encrypted payload works. If no deterministic exhaustive retrieval is possible, do **not** use semantic top-k to calculate exact scores: maintain encrypted ordered event ledger in Walrus with explicit indexed references/receipts and reconstruct via verifiable retrieval/restore; keep local cached score marked stale and demonstrate memory rebuild. Validate actual SDK result shape. If that cannot be demonstrated: **stop, surface blocker; redesign before UI**. Never silently fall back to a DB-only credibility feature.
**K3 - Tatum:** Obtain API key; test real Sui Mainnet gRPC `LedgerService/GetObject` or `GetTransaction` against a *real confirmed object/digest* from Walrus stack; document credentials, endpoint, protobuf/client and actual response. If no relation exists, test cheapest real commitment + readback. Pass when relationship and successful Tatum call are reproducible. Confirm Tatum account usage limits; `unsafe_*` methods unavailable.
**K4 - Football provider:** Choose exactly one documented provider; verify matching fixtures, kickoff and completed full-time score on representative historical events. Confirm 1X2 / BTTS / O-U rules, postponed/abandoned status, rate limits and allowed terms. If unsupported, automatically settle none until provider is proven. Do not fabricate fixtures or scores.
**K5 - Telegram auth:** Implement official Telegram login protocol, verify signed payload, freshness, replay prevention, and CSRF/state on backend. Keep bot `/start` separate; test message permission and secure webhook callbacks. If login experience cannot be verified in deployed HTTPS environment, stop.
**Exit gate:** Publish `docs/INTEGRATION_PROOFS.md` with redacted request/response, real IDs, network, UTC date, evidence URL, and explicit PASS/FAIL for K1-K5. Do not start polish before K1/K2/K3 pass.

## 4. IMPLEMENTATION SEQUENCE / AGENT CONTRACT
**Phase 1 - Foundation (one vertical slice).** Set repo, strict TS, ESLint, tests, SQL migrations, CI, secret checker, environment validation. Telegram sign-in -> session -> private dashboard; two-account isolation test. Mobile-first styling matching approved **first mockup**, refined color/typography; no new design direction.
**Phase 2 - Record.** Analyst create/alias/merge (reversible), match entry, UTC cutoff, multiple picks, exact-duplicate guard, rule-based paste parser, soft daily warning, inline save/actions, archive. Use transactional database + outbox in one commit; never let network memory writes block the save UI.
**Phase 3 - Remember.** Append immutable logical events: CREATED, SETTLED, CORRECTED, ANALYST_MERGED, SNAPSHOT; idempotent outbox worker and Walrus confirmed receipt. Explicit `synced/pending/failed`; retry with exponential backoff and reconciliation to avoid duplicates. Encrypt private payload using AES-256-GCM with random nonce and versioned key; searchable metadata must be non-identifying and never leak Telegram IDs or free-text picks. **Important:** Walrus relayer's native Seal encryption is documented, but application-side encryption and search compatibility still require K2 proof. Do not claim exact full recovery without testing it.
**Phase 4 - Credibility.** Compute deterministic totals from the **validated Walrus-backed historical record**. If cache used, show `last verified` and do not claim fresh recall. Verify full history rather than relying on semantically selected subset. Analyst history card must change after settlement, survive new session, recover after restart/restore, and fail honestly with Walrus disabled.
**Phase 5 - Settle + Telegram.** Provider polling after **confirmed** full-time (not guessed scheduled end); exact market-specific adjudicators; missing data => pending; API failure => bounded retries => manual reminder. Telegram inline buttons are signed/short-lived, scoped by authenticated chat and prediction; send auto-settle evidence plus deep link. Idempotent callbacks, race-safe DB updates and per-user notification preference. Test two users sharing fixture.
**Phase 6 - Tatum evidence.** Real onchain verification endpoint/job; proof record for confirmed object/transaction, RPC transport and response; link to Walrus receipt or valid commitment. UI only displays unobtrusive memory status; no wallet setup.
**Phase 7 - Judge sandbox and privacy + polish.** Build anonymous Try Demo entry, isolated per-visitor sandbox, preloaded SAMPLE data, session expiry/cleanup and clear exit-to-Telegram sign-in. Reuse real production UI and deterministic application rules, but never real personal records, Telegram notifications, paid football API settlement jobs or Walrus Mainnet writes from sandbox interactions. Then tighten RLS, rate limits, session expiry, bot webhook signature/secret, log redaction, CSP, security headers, secret rotation, app-side encryption, backups and deletion workflow. Minimal PWA manifest/icon/static asset caching; **never cache private API responses**. Add accessible empty/loading/error states, keyboard and 360px viewport QA. Test low-end Android interactions.


## 5. ACCEPTANCE TEST MATRIX (REQUIRED, NOT OPTIONAL)
- **Auth:** valid Telegram signed login works; forged/stale/replayed payload rejected; session renewal; account A cannot read or mutate B, including Walrus scope and deep links.
- **Start lock:** 1 second before starts allowed; exactly at start rejected; start passed rejected; user cannot alter event time to reopen; football live status overrides incorrect planned time.
- **Predictions:** create, two markets same fixture, exact duplicate rejected; rule parser ambiguity falls back to manual; user can edit/delete only before start; archive changes visibility not rating.
- **Scoring:** 5 settled = Not Rated; 6 = eligible; 6 pushes = Not Rated; 13 W/7 L => 65% Good; 9 W/11 L => 45% Average; 8 W/12 L => 40% Poor; void excluded; one same-game multi-pick counted individually; verified versus manual separate.
- **Football:** 2-1 settles Arsenal winner, BTTS=Yes, Over 2.5=Yes where selections match; an anytime-goalscorer market cannot auto-settle from score alone; postponed/abandoned/unknown remain pending; cancelled void; missing API data never guessed.
- **Race/error:** Telegram callback duplicate; provider retries; settlement race; memory write failure; outbox retries/no duplicate logical event; Walrus recall unavailable => honest unavailable/stale state; recovery after outage reconstructs correct stats; tamper ciphertext => decryption fails closed.
- **Privacy:** no email/phone capture; no user plaintext in public logs, GitHub, onchain records or monitoring; memory namespace isolation; fresh auth for delete; deletion result accurately reports non-erased storage/chain limitations.
- **Judge demo:** anonymous Try Demo opens on mobile without Telegram/email/wallet; seeded analyst with 6+ settled picks; log -> settle -> corrected score recomputes using same deterministic rules; sessions A/B isolated; demo cannot access production user records or invoke production Mainnet writes/Telegram messages; expiry removes demo state; exit -> Telegram login; demo clearly labeled on every screen; no API VERIFIED label for simulated settlement.
- **E2E:** mobile happy path login -> log -> verify or Telegram settle -> memory synced -> credibility changes -> next analyst selection shows record; logout/login retains records.
- **Proof:** at least 10 distinct **confirmed Mainnet** memories, actual Walrus recall, actual Tatum Sui RPC responses, CI green, deployed HTTPS demo, public repo and article.

## 6. JUDGE-READY INTERACTIVE DEMO (LOCKED MVP REQUIREMENT)
**Landing:** show large primary `Continue with Telegram` and smaller secondary `Try Demo` immediately beneath; supporting copy `Explore without signing in`. No email, wallet, Telegram, or signup to enter demo. Add a persistent small `Demo Mode - sample data` label and an obvious `Exit Demo / Sign in with Telegram` action. Do not auto-enter demo on the real login path.
**Behavior:** Clicking `Try Demo` creates a short-lived, server-authorized anonymous DEMO session with a unique random session ID. Pre-seed private sample events, picks, analysts and outcomes for **that session only**. Reuse the exact production UI components, permissions checks, deterministic score engine, prediction forms, corrections and validation logic. Allow judges to navigate Home / Predictions / Analysts / Settings, inspect profiles, log a sample prediction, record a manual result, and see ratings update. For time-locked sample events, provide clearly labeled pre-start synthetic events relative to demo-session time; never backdate a real submission. Include >=6 settled examples and an unrated analyst. Use Good/Average/Poor and history labels computed from seeded sample outcomes, not hardcoded contradictory values.
**Isolation:** No shared mutable demo user. Use Postgres demo-scoped rows with `demo_session_id` and expiration (or equivalent server-side isolated ephemeral storage); every demo query checks the signed server session and demo scope. Rate-limit session creation/actions; use HTTP-only Secure SameSite cookie; cap demo records and TTL (suggest 60 minutes); scheduled expiry/cleanup. Judge A must never see Judge B changes. No demo access to real user IDs, production Telegram chat IDs, secrets, Walrus credentials, or real user record endpoints. Prefer dedicated demo service functions/authorization boundary rather than trusting a client-side `demo=true` flag.
**Integration truth:** Sandbox sample settlement is `DEMO / SAMPLE / USER-ENTERED`, **never `API_VERIFIED`** unless backed by real returned provider evidence. Demo actions do **not** write Walrus Mainnet, send Telegram messages, invoke real football provider settlement, or create chain transactions. Demo credibility uses production deterministic logic on disposable data. Provide a separate `Verified Integration Evidence` section in the public README (and video) with sanitized **real** Walrus Mainnet confirmations (>=10), actual recall output, and Tatum Sui RPC readback, with provenance clearly distinguished from sandbox data. Do not make claims of a working sponsor integration based on a mock demo.
**Acceptance:** On a clean phone browser: landing -> Try Demo -> dashboard <2 taps; log/settle a sample -> analyst rating updates; refresh preserves same demo until TTL; second incognito demo remains isolated; expired session resets safely; Telegram sign-in unaffected. Verify no demo writes to Mainnet and no bot notifications. Broken demo is a release blocker.
**Video (2-3 min):** 0:00 problem; 0:15 one-tap Try Demo; 0:30 log sample pick; 0:55 credibility changes after sample settlement; 1:20 Telegram behavior via captured real test proof; 1:45 **separately identified live** Walrus Mainnet remember/recall and Tatum Sui query; 2:20 technical reliability/security; end ~2:45. **Do not depend on future live matches.**
**Blog:** product and judge demo walkthrough; who it helps; chronological 10+ **real confirmed Mainnet** memory writes, actual recall and resulting historical credibility; Tatum concrete RPC evidence; encryption/search caveats; mock-vs-real labels, tested limitations, failures, next steps. Screenshots of deployed app plus redacted integration logs.

## 7. DEVELOPER-AGENT WORK RULES
1. Follow **Problem -> Thesis -> Kill-Test -> Proof Design -> Vertical Slice -> Break -> Prove -> Explain -> Market**. Keep changes small and commits reviewable.
2. Before coding any external API: read its **current** official docs, pin SDK versions, write an executable smoke test. No fabricated routes, field names, RPC methods, paid-plan assumptions or Mainnet success.
3. Every phase delivers: implemented code, migration, tests, `README` update, reproducible commands, screenshots/video evidence, PASS/FAIL report, and next risks.
4. No silent shortcuts: failed sponsor kill-test is a release blocker; do not substitute mocked tests for live integration. Mocking is permitted in unit tests only and must be labeled.
5. Preserve exact approved product scope. New features require explicit owner approval; do not build odds feeds, leaderboards, AI, newsletters, native apps, wallets, or charts.
6. Secure secrets; never paste private keys into agent output, issues, commits, test snapshots, or demo. Sanitize logs.
7. Use UTC everywhere. Never call a manually settled outcome verified. Do not invent historic timestamps or prediction wins.
8. Keep owner informed of paid features, provider quotas, onchain fees, and irreversible operations **before** doing them.

## 8. ENVIRONMENT / USER-ONLY SETUP
**Server-only variables (exact provider names vary; document confirmed names):**
```dotenv
DATABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=              # only if needed, backend only
SESSION_SECRET=                         # 32+ random bytes, server only
TELEGRAM_BOT_TOKEN=
TELEGRAM_BOT_USERNAME=
TELEGRAM_WEBHOOK_SECRET=
MEMWAL_KEY=                             # delegated private key
MEMWAL_ACCOUNT_ID=                      # onchain MemWalAccount object ID
MEMWAL_SERVER_URL=https://relayer.memory.walrus.xyz
MEMWAL_NAMESPACE_PREFIX=wwr-
MEMORY_ENCRYPTION_KEY=                  # 32 random bytes; version and rotate
TATUM_API_KEY=
TATUM_SUI_GRPC_ENDPOINT=                # fill from verified docs/test
FOOTBALL_API_KEY=
FOOTBALL_API_BASE_URL=                  # chosen provider, verified
CRON_SECRET=
DEMO_SESSION_SECRET=                    # server-only; separate from real-user session key if needed
DEMO_SESSION_TTL_MINUTES=60              # server-enforced; cleanup job
APP_BASE_URL=
```
No secrets are `NEXT_PUBLIC_*`. Note: managed Walrus relayer handles embeddings/Seal; app-side AES encryption is an **additional layer**, with K2 compatibility tests.
**Demo setup:** seed synthetic demo records with `sample=true` and deterministic fixtures, no provider credentials required for a visitor; use a backend authenticated demo session, never a static public token or shared privileged login. Ensure cleanup job is deployed and monitored.
**Owner must personally:** create/secure Telegram bot with BotFather and supported Telegram Login configuration; create Walrus Memory Mainnet account/delegate, save real account and agent IDs; obtain Tatum API key + required IDs, Sui account/address; approve football provider license/quota; add secrets to hosting environment; fund any required wallet only after cost and safety review; deploy and personally test Telegram on mobile; create Discord/profile and official submission; publish blog, upload 2-3 min video, submit before deadline; make any sponsor bonus claims accurately.

## 9. DELIVERY TIMELINE / STOP RULE
- **Oct 28-29:** kill-tests K1-K5; document architecture choices and proof. If K2/Tatum fails, redesign same day; no UI-first detour.
- **Oct 30-Nov 2:** Telegram login, CRUD, analyst stats, mobile UI, PWA; tests.
- **Nov 3-5:** Walrus event loop + restoration and Tatum readback, exact provider settlement + Telegram.
- **Nov 6-7:** privacy/race tests, seeded real Mainnet memories, failure demo, low-end mobile polish.
- **Nov 8:** public repo README, blog, 2-3 min demo, capture sponsor proofs.
- **Nov 9:** fresh judge walkthrough, full submission field verification, publish/social proof.
- **Nov 10 before 17:00 UTC:** submit **once**, verify acknowledgment; leave buffer for outages.
**Release blocker:** missing 10 confirmed Mainnet memories, non-working Tatum Sui call, privacy breach, fabricated API settlement, no working judge demo, or missing public repo/blog/video. Remove extras, **not** proof, to hit deadline.

## 10. OFFICIAL SOURCES / VERIFY BEFORE CODING
- Hackathon rules: https://thewalrussessions.wal.app/tatum-total-recall/index.html
- Official landing/submission: https://recall-tatum-walrus.vercel.app/
- Walrus overview: https://docs.wal.app/walrus-memory
- Walrus quick start: https://docs.wal.app/walrus-memory/getting-started/quick-start
- SDK overview/usage: https://docs.wal.app/walrus-memory/sdk/overview | https://docs.wal.app/walrus-memory/sdk/usage
- Memory spaces: https://docs.wal.app/walrus-memory/fundamentals/concepts/memory-space
- Relayer trust boundary: https://docs.wal.app/walrus-memory/relayer/overview
- Configuration: https://docs.wal.app/walrus-memory/reference/configuration
- Code/examples: https://github.com/MystenLabs/MemWal
- Tatum getting started: https://docs.tatum.io/docs/getting-started
- Tatum Sui gRPC migration: https://docs.tatum.io/docs/sui-migration-guide-from-json-rpc-to-grpc
- Tatum unsupported unsafe methods: https://docs.tatum.io/docs/sui-unsafe-methods-not-supported
**Research note:** Official documentation was inspected for these sections on 28 Oct 2026. No live secret-authenticated MemWal, Tatum, Telegram, or football-provider integration test has yet been performed. SDK/relayer behavior and current submission-form requirements must be verified in the actual build environment. Winning first place is an objective, not a guarantee.
