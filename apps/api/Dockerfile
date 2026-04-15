FROM node:20-alpine
WORKDIR /app

# PDF-to-image conversion (poppler-utils provides pdftoppm)
RUN apk add --no-cache poppler-utils

# Copy entire monorepo
COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/

# Install all deps
RUN npm install --workspaces --include-workspace-root

# Copy source
COPY tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

# Generate Prisma client (code-gen only, no DB contact)
RUN npx prisma generate --schema=packages/db/prisma/schema.prisma

# Build TypeScript
RUN npx tsc --project apps/api/tsconfig.json

# Copy startup script
COPY apps/api/start.sh ./start.sh
RUN chmod +x ./start.sh

EXPOSE 3001
ENV PORT=3001

# start.sh runs: prisma migrate deploy (safe, additive-only) → node server
# It does NOT run seed, db push, or migrate dev. Ever.
CMD ["./start.sh"]
