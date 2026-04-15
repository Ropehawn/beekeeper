# BeeKeeper — Claude Code Instructions

## Data Safety Rules (MANDATORY)

The database is sacred. Application code and user data live in separate silos.

### Never do these things:
- **Never** run `prisma db push` against any environment. It has been removed from all scripts.
- **Never** add seed calls, `db push`, or `migrate dev` to Dockerfiles, CI pipelines, or deploy hooks.
- **Never** write migrations that DROP columns, DROP tables, or DELETE data. All migrations must be additive.
- **Never** run `prisma migrate dev` against the production database. It is for local development only.
- **Never** add `prisma db push` back to package.json scripts.
- **Never** put destructive SQL (DROP, TRUNCATE, DELETE without WHERE) in migration files.
- **Never** auto-run the seed script. It requires manual invocation with `SEED_CONFIRM=yes` for production.

### Always do these things:
- Schema changes go through `prisma migrate dev --name descriptive_name` locally, which creates a migration file.
- Production deploys apply migrations via `prisma migrate deploy` (in start.sh). This only runs pre-written, reviewed migration files.
- New columns must have defaults or be nullable — never add a required column without a default to a table with existing data.
- Test migrations locally before deploying. Run `db:migrate:status` to verify.

### Architecture:
- **Web service**: Static HTML + Express proxy. No database access.
- **API service**: Express + Prisma. Connects to Postgres via `DATABASE_URL`.
- **Database**: Railway Postgres. Persists across all deploys. Never rebuilt.
- **Migrations**: `packages/db/prisma/migrations/` — append-only history. Each migration is a numbered SQL file.
- **Seed**: `packages/db/prisma/seed.ts` — manual, one-time setup. Uses upsert, skips existing data, has production guard.

## Project Structure
- `apps/web/` — Frontend (static HTML served by Express, API proxy)
- `apps/api/` — Backend (Express + Prisma, TypeScript)
- `packages/db/` — Prisma schema, migrations, seed
- `packages/shared/` — Shared types

## Deploy
- **Source of truth:** GitHub repo `Ropehawn/beekeeper`, branch `main` (private).
- **How deploys trigger:** `git push origin main` — Railway auto-builds and deploys both `beekeeper-web` and `beekeeper-api` from the pushed commit.
- **Build context:** Railway uses repo root (`/`) for both services. Dockerfile paths: `apps/web/Dockerfile` and `apps/api/Dockerfile`.
- **Fallback:** `railway up` from project root still works if you need to deploy uncommitted local changes during an outage. Avoid in normal operation — it bypasses version control.
- API startup: `start.sh` runs `prisma migrate deploy` then `node server.js`
- Web startup: `node server.js` (static server + API proxy)
- **Rollback:** revert the offending commit on `main` and push, OR redeploy a prior image from the Railway dashboard.

## Key URLs
- Web: https://beekeeper-web-production.up.railway.app
- API: https://beekeeper-api-production.up.railway.app
- Health: https://beekeeper-api-production.up.railway.app/health
- Scheduler status: https://beekeeper-api-production.up.railway.app/health/scheduler

## Environment Variables (API service)

### Required — server will not start without these
| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Signs auth tokens — must be a long random string |

### Expected — features degrade at runtime if missing
| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Email sending (alerts, invites, password reset) |
| `ANTHROPIC_API_KEY` | AI frame photo analysis |
| `R2_ACCOUNT_ID` | Cloudflare R2 storage account |
| `R2_ACCESS_KEY_ID` | R2 credentials |
| `R2_SECRET_ACCESS_KEY` | R2 credentials |
| `R2_BUCKET_NAME` | R2 bucket for frame photos |

### Optional — behaviour changes
| Variable | Purpose |
|----------|---------|
| `DISABLE_SCHEDULER` | Set to any non-empty value to skip cron job registration. Use on replica instances to prevent duplicate alert emails. |
| `PORT` | API listen port (default: 3001) |
| `WEB_URL` | Frontend origin for CORS (default: http://localhost:3000) |
| `CORS_ORIGINS` | Comma-separated allowed origins (overrides WEB_URL) |
| `API_URL` | Public base URL of the API service (default: http://localhost:3001). Used to build unsubscribe links in alert digest emails. Set to `https://beekeeper-api-production.up.railway.app` in production. |
| `LOG_LEVEL` | Minimum log level to emit: `debug`, `info`, `warn`, `error` (default: `info`) |
| `ANTHROPIC_MODEL` | Claude model used for frame photo analysis (default: `claude-opus-4-5`). Override when upgrading to a newer model. |
| `UNIFI_API_KEY` | UniFi Site Manager API key. Generated at account.ui.com → Security → API Keys. Used with `X-API-Key` header on all api.ui.com calls. |
| `UNIFI_HOST_ID` | Protect console host ID (e.g. `900A6F003011...`). Obtained from `GET https://api.ui.com/v1/hosts` or via the `/api/v1/sensors/test-connection` route when `UNIFI_HOST_ID` is missing (it returns `availableHosts`). Railway proxies sensor requests through `api.ui.com/v1/connector/consoles/{hostId}/proxy/protect/integration/v1/sensors`. |
| `PROTECT_HOST` | Reserved for future camera snapshot integration — not used by the sensor path. |
| `PROTECT_API_KEY` | Reserved for future camera snapshot integration — not used by the sensor path. |

## Database Connection Pool
Prisma pool size defaults to `(num_cpus * 2 + 1)` — uncontrolled on Railway containers.
**Set explicitly in `DATABASE_URL`:**
```
DATABASE_URL="postgresql://user:pass@host/db?connection_limit=5&pool_timeout=20"
```
- `connection_limit=5` — safe for Railway Hobby plan (max 25 connections)
- `pool_timeout=20` — seconds to wait for a free connection before throwing
- Raise `connection_limit` if you upgrade to Railway Pro and add more load
