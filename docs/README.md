# Backend Database Docs

## Stack

- Database engine: PostgreSQL
- ORM and migrations: Prisma (`@prisma/client` + Prisma CLI)
- Canonical schema file: `backend/prisma/schema.prisma`
- Migration scripts: `backend/prisma/migrations/*/migration.sql`

## Which database is used

The backend uses `DATABASE_URL` from `backend/.env`.

Typical values:

- Local host machine to local Docker Postgres:
  - `postgresql://postgres:postgres@localhost:5432/ads_marketplace?schema=public`
- Container-to-container (inside Docker network):
  - `postgresql://postgres:postgres@postgres:5432/ads_marketplace?schema=public`

## Prisma workflow

Useful commands (run in `backend/`):

```bash
npm run db:generate      # Generate Prisma client
npm run db:migrate       # Create/apply dev migration from schema changes
npm run db:migrate:prod  # Deploy existing migrations (no diff generation)
npx prisma migrate status
npm run db:seed
npm run db:studio
```

Recommended order after schema updates:

```bash
npm run db:generate
npx prisma validate
npx prisma migrate status
npm run db:migrate:prod   # or db:migrate in local dev
```

## Documentation files

- [`database-table-catalog.md`](./database-table-catalog.md): schema-level table descriptions and relations.
- [`database-erd.svg`](./database-erd.svg): ERD diagram.

## Notes

- `schema.prisma` is the source of truth for target schema.
- Physical databases can temporarily differ until all migrations are applied.
