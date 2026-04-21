#!/bin/sh
# ──────────────────────────────────────────────────────────
# API startup script — runs on every deploy
#
# 1. prisma migrate deploy  — applies ONLY pending, pre-written
#    migrations. This is safe: it never generates SQL on the fly,
#    never drops columns, never deletes data. It reads the
#    migrations/ folder and applies anything not yet in
#    _prisma_migrations table.
#
# 2. node server.js — starts the API
#
# What this does NOT do:
#   - prisma db push   (destructive schema sync — BANNED)
#   - prisma migrate dev (generates new migrations — dev only)
#   - seed.ts           (never runs automatically)
# ──────────────────────────────────────────────────────────

set -e

echo "Running pending database migrations..."
npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
echo "Migrations complete."

echo "Starting API server..."
exec node apps/api/dist/apps/api/src/server.js
