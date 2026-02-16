# Backend - Ads Marketplace

## Purpose
Backend service layer for the Ads Marketplace system:
- REST API for marketplace and deal operations
- background job processing (timeouts, posting, verification, stats refresh)
- Telegram bot runtime for user notifications and deal chat actions
- TON escrow orchestration and status transitions

Detailed technical walkthrough:
- [`docs/backend-technical.md`](docs/backend-technical.md)

## Runtime Topology (API/Worker/Bot)
| Runtime | Entrypoint | Local command | Role |
|---|---|---|---|
| API | `src/server.ts` | `npm run dev:api` | HTTP API, auth, business routes, docs (`/api-docs`) |
| Worker | `src/workers/main.ts` | `npm run dev:worker` | BullMQ processors and recurring automation |
| Bot | `src/workers/telegram-bot.ts` | `npm run dev:bot` | Telegram long-polling commands, deal chat relay, notifications |

Production note: keep bot replicas at `1` to avoid duplicate long-polling update consumption.

## Local Setup
### Prerequisites
- Node.js 20+
- PostgreSQL
- Redis
- Telegram bot token from `@BotFather`

### Setup
```bash
cd backend
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate
```

### Run processes
Run each runtime in its own terminal:
```bash
npm run dev:api
npm run dev:worker
npm run dev:bot
```

### Build and tests
```bash
npm run build
npm run lint
npm run test
```

## Environment Variables
Canonical keys are defined in `.env.example` and in `src/config/index.ts`.
Deprecated aliases are rejected at startup.

### Runtime matrix
| Variable group | API | Worker | Bot | Notes |
|---|---:|---:|---:|---|
| `DATABASE_URL` | Yes | Yes | Yes | Shared persistence |
| `REDIS_URL` | Yes | Yes | Yes | Queue + cache |
| `JWT_SECRET` | Yes | Optional | Optional | Required for API auth |
| `CORS_ORIGINS` | Yes | No | No | API-only CORS policy |
| `TELEGRAM_BOT_TOKEN` | Optional | Optional | Required | Bot runtime exits if missing |
| `TELEGRAM_BOT_USERNAME` | Optional | Optional | Recommended | Deep links and bot URLs |
| `MINI_APP_BASE_URL` | Yes | Optional | Recommended | Manifest/links generation |
| TON/escrow keys (`TON_*`, `ESCROW_FACTORY_ADDRESS`, wallet vars) | Yes | Yes | Optional | Contract and payout operations |
| Media storage keys (`MEDIA_*`, `AWS_*`) | Yes | Optional | No | Upload + media URL handling |
| Admin config (`ADMIN_TELEGRAM_IDS`) | Yes | No | Optional | Admin route access checks |

## API Docs
- Swagger UI: `GET /api-docs`
- OpenAPI export command:
```bash
npm run openapi:export
```
- Route modules are in `src/routes/` (`auth`, `users`, `channels`, `listings`, `briefs`, `deals`, `admin`, `media`).

## Bot Commands and Deep Links
Source: `src/services/telegram/bot.ts`

### Commands
- `/start` - default entry and deep-link handler
- `/openchat <deal_id>` - open deal chat topic
- `/repairchat <deal_id>` - repair/recreate deal chat topic
- `/chatdiag <deal_id>` - diagnostics for topic routing/deliverability
- `/status` - deal status summary for active session deal
- `/verify <channel_id>` - channel bot/admin verification entrypoint
- `/close` - close current deal chat topic in private chat context

### Supported `/start` params
- `deal_chat_<dealId>`
- `open_deal_<dealId>`
- `repair_deal_<dealId>`
- `deal_<dealId>`
- `channel_<channelId>`

## Queue/Event Automation
### Queue jobs
Defined in `src/services/jobs/index.ts`:
- stats: `REFRESH_CHANNEL_STATS`, `REFRESH_ALL_STATS`
- posting: `PUBLISH_POST`
- verification/monitoring: `VERIFY_POST`, `MONITOR_POST`
- lifecycle/timeouts: `CHECK_DEAL_TIMEOUTS`, `SEND_TIMEOUT_WARNING`, `EXPIRE_DEAL`
- channel checks: `VERIFY_CHANNEL_ADMIN`, `RECHECK_ALL_ADMIN_STATUS`

### Event-driven actions
Defined in `src/services/listeners.ts` + `src/services/events.ts`:
- escrow release/refund triggers on terminal deal and violation events
- auto-post scheduling after creative approval
- deal chat finalization when deal transitions to terminal statuses
- channel verification and suspension workflows

## Posting Permission Validation
- Channel onboarding (`POST /api/channels/verify-and-add`) validates:
  - authenticated user is channel `creator`/`administrator`,
  - bot is admin with `can_post_messages`.
- Automated posting calls `verifyAdminBeforeOperation(channelId)` before publish, which rechecks bot admin status when stale and blocks posting if permissions are missing.
- Owner-only channel reactivation (`POST /api/channels/:id/activate`) reruns admin verification before returning channel to active.

## MTProto Analytics Notes
- Detailed channel analytics are available only through MTProto and require connecting a Telegram account with channel stats permissions (typically owner/admin).
- Auth flow uses:
  - `POST /api/users/telegram-auth/start`
  - `POST /api/users/telegram-auth/code`
  - `POST /api/users/telegram-auth/password` (when 2FA is enabled)
  - `GET /api/users/telegram-auth/status`
  - `POST /api/users/telegram-auth/disconnect`
- Session data is encrypted at rest (`src/services/telegram/userAuth.ts`, AES-256-GCM with `MTPROTO_SESSION_ENCRYPTION_KEY`).
- If MTProto detailed stats are unavailable, backend falls back to Bot API analytics (less rich but bot-safe baseline metrics).
- Current design uses owner-linked sessions; a dedicated service account for public-channel MTProto analytics is a possible future mitigation for auth-friction concerns.

## Railway Deployment
Deploy three backend services from monorepo context:
- API service: `RAILWAY_DOCKERFILE_PATH=/backend/Dockerfile.api`
- Worker service: `RAILWAY_DOCKERFILE_PATH=/backend/Dockerfile.worker`
- Bot service: `RAILWAY_DOCKERFILE_PATH=/backend/Dockerfile.bot`

Recommended sequence:
1. Provision PostgreSQL + Redis + S3-compatible storage.
2. Set environment variables using `.env.example` canonical keys.
3. Deploy API, Worker, Bot services.
4. Set bot replicas to `1`.
5. Run migrations:
```bash
npm run db:migrate:prod
```

## Known Limitations
Code-backed current limitations:
- Testnet-first TON setup in current baseline; mainnet hardening/ops profile is not the default path yet.
- Escrow payment endpoint is TON-only (`/api/deals/:id/fund` enforces `currency === TON`).
- End-to-end automated publishing is currently post-oriented; other ad formats do not have a dedicated automated pipeline yet.
- `src/services/ton/index.ts`: `verifySignature` is a stub (valid address check only).
- `src/services/ton/index.ts`: `waitForTransaction` is a stub.
- `src/services/escrow/index.ts`: historical escrow refund handling is partial in some edge states.
- `src/services/telegram/posting.ts`: post existence checks are placeholder/stubbed.
- `src/services/telegram/posting.ts`: media-capable channel posting path is incomplete.
- `src/services/telegram/bot.ts`: `/verify` command includes placeholder verification action.
- `src/routes/admin.ts`: dispute resolution endpoint does not execute fund distribution yet.
- Backend i18n is partial; many API/bot/system messages are currently hardcoded in English.

## Troubleshooting
- Bot exits immediately with `TELEGRAM_BOT_TOKEN is not set`:
  - set `TELEGRAM_BOT_TOKEN` in `.env` and restart bot runtime.
- Duplicate bot notifications/actions:
  - ensure only one bot runtime instance is active.
- CORS errors in production:
  - add frontend domain to `CORS_ORIGINS` exactly (scheme + host).
- TON actions fail at runtime:
  - verify `TON_CENTER_API_URL`, `TON_CENTER_API_KEY`, wallet mnemonics, and `ESCROW_FACTORY_ADDRESS`.
- Media upload/read failures:
  - verify `MEDIA_STORAGE_DRIVER` and all required `AWS_*` keys.
