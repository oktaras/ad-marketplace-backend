# Backend Technical Description

## Core Tools Used

| Tool | Where used | What it does in this backend |
|---|---|---|
| Express | `src/app.ts`, `src/routes/*.ts` | HTTP API layer and route composition |
| Prisma + PostgreSQL | `src/lib/prisma.ts`, `prisma/schema.prisma` | Data model, queries, migrations |
| Redis + BullMQ | `src/lib/redis.ts`, `src/services/jobs/*` | Queueing, retries, recurring background jobs |
| grammy | `src/services/telegram/bot.ts` | Telegram bot commands, topic operations, relay |
| TON SDK (`@ton/ton`, `@ton/core`, `@ton/crypto`) | `src/services/ton/index.ts`, `src/services/escrow/index.ts` | Wallet operations and escrow contract interaction |
| Zod | route files (e.g. `src/routes/deals.ts`) | Request payload validation |
| `@telegram-apps/init-data-node` | `src/middleware/auth.ts` | Telegram Mini App init-data verification |
| `swagger-jsdoc` + `swagger-ui-express` | `src/config/swagger.ts`, `src/app.ts` | OpenAPI spec generation + docs UI |
| Helmet / CORS / rate-limit | `src/app.ts` | Baseline HTTP hardening controls |

## Runtime Model

### API runtime
- Entrypoint: `src/server.ts`
- Initializes API runtime with:
  - event listeners (`setupEventListeners()`)
  - BigInt JSON serialization guard (`initializeApiRuntime()`)
- Serves routes, Swagger UI (`/api-docs`), and TonConnect manifest endpoint (`/api/tonconnect-manifest.json`).

### Worker runtime
- Entrypoint: `src/workers/main.ts`
- Initializes:
  - event listeners
  - BullMQ processors (`registerJobProcessors`)
  - recurring jobs (`setupRecurringJobs`)
- Recurring jobs include:
  - analytics refresh (cron from env)
  - timeout checks (hourly)
  - channel admin recheck (daily)
  - post monitoring (every 15 minutes)

### Bot runtime
- Entrypoint: `src/workers/telegram-bot.ts`
- Starts long-polling bot via `telegramBot.startBot()`.
- Requires `TELEGRAM_BOT_TOKEN`.
- Designed to run as a single replica to avoid duplicate update consumption.

## Solution Strengths (Implemented)

- **Isolated runtime responsibilities**: API, worker, and bot are separated into dedicated entrypoints/processes, reducing cross-impact of failures.
- **Single-source API contract**: route-level `@openapi` annotations feed both live Swagger UI and exported OpenAPI JSON.
- **Escrow safety checks in backend flow**: funding verification, first-transaction validation, and escrow rotation logic are implemented around contract interaction.
- **Audit-friendly payment handling**: escrow operations create/update transaction records with idempotency keys and status transitions.
- **Controlled relay model for counterparties**: relay routing enforces deal participation and thread mapping.
- **Graceful analytics degradation**: stats provider chain prefers MTProto when available and falls back to Bot API when detailed access is unavailable.

## API Contract and OpenAPI Generation

### How API docs are built
- OpenAPI annotations live in route files as `@openapi` JSDoc blocks (for example in `src/routes/deals.ts`).
- `src/config/swagger.ts` builds `swaggerSpec` with `swagger-jsdoc`.
- The glob resolver supports both deployment modes:
  - backend as service root
  - monorepo root with `backend/` nested

### How docs are served and exported
- Swagger UI endpoint: `GET /api-docs` (configured in `src/app.ts`).
- Export command:
```bash
npm run openapi:export
```
- Export script: `scripts/export-openapi.ts`
- Output file: `openapi/openapi.json`

This gives one source for API docs in runtime UI and one static artifact for client generation.

## Escrow Integration (Backend <-> TON)

Escrow integration is implemented through `src/routes/deals.ts` + `src/services/escrow/index.ts` + `src/services/ton/index.ts`.

### 1) Payment intent endpoint (`POST /api/deals/:id/fund`)
Implemented behavior:
- requires authenticated advertiser on that deal (`telegramAuth`)
- enforces deal state (`TERMS_AGREED` -> `AWAITING_PAYMENT` path)
- creates per-deal escrow record if missing (`createDealEscrow`)
- generates funding transaction payload (`getEscrowFundingTransaction`)

Returned payload includes:
- contract address
- expected/total amount
- TON transfer deep link
- `Fund` payload (opcode `1`)
- optional `stateInit` for lazy deployment path

### 2) Payment verification endpoint (`POST /api/deals/:id/verify-payment`)
Implemented behavior:
- allows only deal parties
- validates first funding transaction invariants via `validateAndRotateFirstFundingTransaction`:
  - sender expectations
  - init/deploy expectations
  - opcode/dealId expectations
- rotates escrow target on invalid first funding patterns
- verifies contract funding state (`verifyFunding`)
- updates deal/escrow statuses and amounts when funded

### 3) Release/refund execution
Triggered by domain events in `src/services/listeners.ts`:
- `DEAL_COMPLETED` -> `releaseFunds`
- `POST_VIOLATION_DETECTED`, `DEAL_CANCELLED`, `DEAL_TIMED_OUT` -> `refundFunds` (when applicable)

Execution characteristics:
- platform wallet sends on-chain messages (`Release` opcode `2`, `Refund` opcode `3`)
- idempotency keys are used for transaction records (`release-<dealId>`, `refund-...`)
- transaction rows are updated through pending/confirmed/failed states

## MTProto Analytics Access Model

Analytics provider selection is implemented in `src/services/telegram/stats.ts`:
- first provider: `MtprotoStatsProvider` (`StatsSource.MTPROTO`)
- fallback provider: `BotApiStatsProvider` (`StatsSource.BOT_API`)

### Detailed analytics path (MTProto)
- Detailed channel analytics are fetched only when the channel owner's marketplace account has an authorized MTProto session:
  - `hasAuthorizedMtprotoSession(ownerId)` gate in provider selection.
- Session onboarding flow is exposed via user endpoints:
  - `POST /api/users/telegram-auth/start` (request code)
  - `POST /api/users/telegram-auth/code` (submit code)
  - `POST /api/users/telegram-auth/password` (submit 2FA password if required)
  - `GET /api/users/telegram-auth/status`
  - `POST /api/users/telegram-auth/disconnect`
- Session data is stored encrypted in `user_telegram_sessions`:
  - AES-256-GCM encryption in `src/services/telegram/userAuth.ts`
  - encryption key derived from `MTPROTO_SESSION_ENCRYPTION_KEY`
- Channel-level eligibility is still constrained by Telegram-side permissions:
  - MTProto fetch checks `canViewStats` and marks detailed stats unavailable when Telegram denies access.
  - In practice, detailed stats depend on the connected Telegram account having stats-view permissions on that channel (typically owner/admin level).

### Fallback path (Bot API, less rich)
- When MTProto is not available/authorized/eligible, backend falls back to Bot API stats (`getChat`, `getChatMemberCount`).
- This provides baseline metrics (for example subscriber count and basic channel metadata) but not the full detailed analytics set.
- Access policy for viewers is handled in `resolveDetailedAnalyticsAccess(...)` so non-owner viewers receive generic reasons while owner viewers get actionable reasons.

### UX/Security tradeoff (implemented behavior)
- To unlock detailed analytics, users must provide verification code and potentially Telegram 2FA password through the auth flow above.
- Although backend stores session state encrypted at rest, this step is high-friction and can be perceived as sensitive by users.

### Potential mitigation (not implemented yet)
- A dedicated service MTProto account for public-channel analytics could reduce owner-facing auth friction for some use cases.
- This is not implemented in current code; current design uses owner-linked user sessions.

## Secured Anonymized Relay Between Parties

Relay implementation lives in:
- `src/services/deal-chat/index.ts`
- `src/services/telegram/bot.ts`
- schema model `DealChatBridge` in `prisma/schema.prisma`

### Routing and access boundaries
- Route resolution is based on:
  - authenticated Telegram user (`telegramId`)
  - deal participation (advertiser or publisher only)
  - mapped topic/thread IDs in `DealChatBridge`
- Non-participants are blocked in participant resolution (`ForbiddenError` path).
- Per-deal/per-side advisory locks (`pg_advisory_xact_lock`) are used to prevent chat bridge race conditions.

### Relay gating
In `bot.on('message')` relay handler:
- only private chats are processed
- bot commands and contact-sharing payloads are ignored
- direct messages without topic/thread context are rejected with guidance
- messages relay only when bridge status is `ACTIVE` and destination thread is available

### Anonymization behavior
- Text/caption relay is rewritten with role labels (`Advertiser:` / `Publisher:`) via `formatParticipantRoleLabel`.
- Media is relayed topic-to-topic through bot copy/send calls.
- Current database schema stores thread bridge metadata (`deal_chat_bridges`) and does not include a table for persisted relay message bodies.

### Topic lifecycle safety
- Topic creation/opening is explicit per participant side.
- Missing/deleted destination topics trigger recovery logic with one retry path (neds to be refined).
- Deal close finalizes topics by delete (if supported) or rename fallback.
- Terminal deal statuses trigger system-side chat close/finalization.

## Posting Permission Validation (Owner/Admin + Bot)

Posting safety checks are split across channel onboarding and publish-time verification.

### Owner/admin validation on channel binding
- `POST /api/channels/verify-and-add` validates that the authenticated user is channel `creator`/`administrator` before the channel can be registered.
- The same flow validates that the bot is administrator with `can_post_messages` before marking channel as verified/active.
- `POST /api/channels/:id/activate` is owner-only and reruns channel admin verification before reactivation.

### Publish-time bot-admin validation
- Automated posting (`publishDealCreative` in `src/services/telegram/posting.ts`) calls `verifyAdminBeforeOperation(channelId)` before sending content.
- `verifyAdminBeforeOperation` in `src/services/telegram/verification.ts`:
  - rechecks Telegram admin status if cached status is stale (>1 hour) or bot is marked non-admin,
  - blocks posting if bot is not admin with required post permission.
- Channel admin status is also rechecked by scheduled jobs (`RECHECK_ALL_ADMIN_STATUS`) and loss events can trigger status enforcement flows.

### Scope boundary
- Current publish-time validation is centered on bot posting permissions.
- Human owner/admin membership is validated at channel registration/activation; it is not revalidated on every single post publish operation.

## Security Controls in API Layer

Implemented controls:
- `helmet()` security headers (`src/app.ts`)
- CORS allowlist behavior in production (`CORS_ORIGINS`)
- request rate limiting (`express-rate-limit`)
- Telegram init-data verification with expiry window in `telegramAuth`
- JWT auth path for token-based access (`jwtAuth`)
- centralized error mapping (`errorHandler`) with reduced detail outside development

## Auditability and Transparency in Backend Flows

Implemented audit surfaces:
- `deal_events` table for workflow events and status transitions
- `transactions` table for escrow payment/release/refund attempts and statuses
- `escrow_wallets` state tracking (`isDeployed`, `cachedBalance`, `status`, `lastSyncedAt`)
- queue job completion/failure logging via BullMQ queue events

## Current Boundaries / Limitations

Code-backed limitations relevant to this technical scope:
- Testnet-first TON setup:
  - defaults point to testnet TON Center endpoints in config/env templates
  - blockchain deployment script in this repo is `deployToTestnet.ts`
- TON signature verification in `src/services/ton/index.ts` is currently a stub.
- Generic transaction polling in `src/services/ton/index.ts` is currently a stub.
- Escrow funding API is TON-only in current payment endpoint flow (`/api/deals/:id/fund` validates `currency === TON`).
- Ad format catalog includes multiple types (`POST`, `STORY`, `REPOST`, `PINNED`, `OTHER`), but automated publishing flow is channel-message oriented (no dedicated story/repost/pinned publishing pipeline).
- Historical escrow refund edge handling in `src/services/escrow/index.ts` is partial.
- Telegram posting verification/media posting paths in `src/services/telegram/posting.ts` are partial.
- Admin dispute endpoint does not yet perform automated payout distribution (`src/routes/admin.ts`).
- Backend i18n is partial:
  - no backend i18n framework is wired in runtime
  - many API/bot/system messages are hardcoded English strings.

