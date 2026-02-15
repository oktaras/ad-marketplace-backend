FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies first for better layer caching.
FROM base AS deps
COPY package*.json ./
COPY prisma ./prisma/
RUN apk add --no-cache python3 build-base && ln -sf /usr/bin/python3 /usr/bin/python
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Build TypeScript output and generate Prisma client.
FROM deps AS builder
COPY . .
RUN npm run db:generate
RUN npm run build
RUN apk del build-base || true
RUN npm prune --omit=dev

# Local development image (API by default; override command as needed).
FROM deps AS development
COPY . .
RUN npm run db:generate
ENV NODE_ENV=development
EXPOSE 3000
CMD ["npm", "run", "dev:api"]

# Production image with selectable runtime role.
FROM node:20-alpine AS production
WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.env.example ./.env.example

RUN mkdir -p .uploads

EXPOSE 3000

CMD ["sh", "-c", "case \"$APP_ROLE\" in api) exec node dist/server.js ;; worker) exec node dist/workers/main.js ;; bot) exec node dist/workers/telegram-bot.js ;; *) echo \"Invalid APP_ROLE: $APP_ROLE (expected api|worker|bot)\" >&2; exit 1 ;; esac"]
