# Claude Code Working Agreement

Rules for any Claude Code session working in the BeeKeeper repository. These supplement `CLAUDE.md` with behavioral expectations.

---

## 1. Read Before Write

- Read `CLAUDE.md`, `ARCHITECTURE.md`, and `PROJECT.md` before making changes
- Read the file you intend to modify before editing it
- Check `git status` and `git log --oneline -5` at the start of every session
- If a `docs/RESUME_HERE.md` exists, read it first — it contains handoff context from a prior session

## 2. Database is Sacred

- Never run `prisma db push`
- Never write DROP/TRUNCATE/DELETE-without-WHERE in migrations
- Always use `prisma migrate dev --name descriptive_name` for schema changes
- New columns: nullable or with defaults, always
- Test migrations locally before committing

## 3. Commit Discipline

- Separate code changes from documentation changes
- Separate schema migrations from application logic
- Never commit `.env`, secrets, or API keys
- Never commit `node_modules/`, `dist/`, `.turbo/`, `.next/`
- Never commit `runs/`, `training/`, or `*.log` files
- Commit messages: imperative mood, concise, explain why not what

## 4. Domain Package Rules

Domain packages (`packages/domain/*`) are pure TypeScript modules:

- **No I/O**: no database calls, no HTTP requests, no file system access
- **No framework imports**: no Express, no Prisma, no React
- **Allowed imports**: other domain packages, `packages/shared`
- **Exports**: types, validators, selectors, constants, pure functions
- **Purpose**: the API layer imports domain logic, not the other way around

## 5. File Modification Boundaries

| If you need to... | Modify... | Never modify... |
|-------------------|-----------|-----------------|
| Add an API endpoint | `apps/api/src/routes/*.ts` | `apps/web/` |
| Change the schema | `packages/db/prisma/schema.prisma` + new migration | Existing migration files |
| Add a domain type | `packages/domain/*/types.ts` | `apps/api/` (import it instead) |
| Change UI behavior | `apps/web/public/index.html` or `api-client.js` | `apps/api/` (unless adding a new endpoint) |
| Add a shared type | `packages/shared/src/` | Domain-specific files |

## 6. Testing

- API routes have co-located test files (`*.test.ts`)
- Tests use Vitest
- Mock external services (UniFi, Resend, Claude API) — never call real APIs in tests
- Test the happy path and the most likely failure mode

## 7. Session Handoff

If work is incomplete at the end of a session:
- Commit what is stable
- Create or update `docs/RESUME_HERE.md` with:
  - What was done
  - What remains
  - Any decisions made or deferred
  - Files touched

## 8. No Speculative Work

- Don't add features, abstractions, or error handling beyond what the task requires
- Don't refactor adjacent code unless the task requires it
- Don't create planning documents unless asked
- Don't add comments explaining what code does — only why, when non-obvious
