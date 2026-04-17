# BeeKeeper Architecture Contract

This document defines the architectural boundaries, ownership rules, and constraints that all code changes must respect. It is the enforceable companion to `ARCHITECTURE.md` (which describes intent) and `CLAUDE.md` (which describes tooling rules).

---

## 1. Service Boundaries

| Service | Owns | Connects to | Never does |
|---------|------|-------------|------------|
| `apps/web` | Static HTML, client-side JS, API proxy | API service via HTTP proxy | Direct database access, secret storage |
| `apps/api` | REST endpoints, auth, business logic, cron jobs | PostgreSQL via Prisma, R2, Resend, UniFi API, Claude API | Serve HTML pages, hold client state |
| `packages/db` | Prisma schema, migrations, seed | PostgreSQL | Business logic, HTTP handling |
| `packages/shared` | Shared TypeScript types, constants | Nothing | Side effects, I/O, database calls |
| `packages/domain/*` | Domain types, validators, selectors per bounded context | `packages/shared` only | I/O, database calls, HTTP, framework imports |
| `hardware/tachyon-hub` | Edge device firmware, BLE scanning, upload | API service via HTTPS | Direct database access |

## 2. Domain Boundaries

Each domain package (`packages/domain/*`) represents a bounded context:

| Domain | Scope | Does NOT own |
|--------|-------|-------------|
| `hardware` | Sensor devices, camera devices, hub registration, BLE provisioning, polling config | Sensor readings storage, alert logic |
| `inspections` | Inspection records, frame observations, frame photos, AI analysis results | Hive structure, sensor data |
| `hives` | Hive registry, component stack, frame layout, apiary config | Inspection history, sensor readings |
| `intelligence` | Health scoring, prediction models, AI analysis orchestration, alert rules | Raw sensor storage, UI rendering |

## 3. Data Flow Direction

```
hardware sensors → API ingestion → database → intelligence scoring → API response → web display
                                             → alert evaluation → email/push
```

Data flows **inward** (hardware → API → DB) and **outward** (DB → intelligence → API → web). Domain packages never call each other directly — they share data through the database and API layer.

## 4. Database Rules

These rules are non-negotiable. See `CLAUDE.md` for the full list.

- Migrations are append-only SQL files created via `prisma migrate dev`
- Production applies migrations via `prisma migrate deploy` (in `start.sh`)
- Never DROP columns, tables, or DELETE data in migrations
- New columns must have defaults or be nullable
- Never run `prisma db push` against any environment

## 5. API Conventions

- All endpoints under `/api/v1/`
- Auth via JWT in `Authorization: Bearer` header
- Role-based access: `queen`, `worker`, `spectator`
- Request validation at the route handler level
- Errors return `{ error: string }` with appropriate HTTP status
- Timestamps in ISO 8601 UTC

## 6. Frontend Constraints

- `apps/web/public/index.html` is a single-page application (vanilla JS)
- No build step — served as static files by Express
- API calls go through `api-client.js` wrapper
- All state is ephemeral (no client-side persistence beyond session)

## 7. Environment Variable Rules

- Secrets live in Railway environment variables, never in code or `.env` files committed to git
- `.env.example` documents all variables with placeholder values
- API server hard-fails on missing `DATABASE_URL` and `JWT_SECRET`
- All other variables degrade gracefully with logged warnings

## 8. Deploy Contract

- Source of truth: `Ropehawn/beekeeper` on GitHub, branch `main`
- `git push origin main` triggers Railway auto-deploy
- Both services (`beekeeper-web`, `beekeeper-api`) deploy from the same commit
- Rollback: revert commit and push, or redeploy prior image from Railway dashboard
