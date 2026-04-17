# @beekeeper/domain-intelligence

Intelligence domain package — types, validators, and selectors for health scoring, prediction models, AI analysis orchestration, and alert rule evaluation.

## Scope

This package owns the **prediction and analysis layer**: health score computation, swarm/disease prediction schemas, AI analysis prompt structures, and alert threshold rules. It defines *what* intelligence produces, not *how* it is computed (model invocation lives in `apps/api`).

| Owns | Does NOT own |
|------|-------------|
| Health score types and thresholds | Raw sensor storage (that's `hardware` + `packages/db`) |
| Prediction result schemas | Model invocation (that's `apps/api` calling Claude/ML APIs) |
| Alert rule definitions | Email/push delivery (that's `apps/api/jobs`) |
| AI prompt structures | Frame photo storage (that's `inspections` + R2) |
| Confidence scoring types | UI rendering (that's `apps/web`) |

## File Structure

| File | Purpose |
|------|---------|
| `types.ts` | Health score, prediction, alert, AI analysis interfaces |
| `api.ts` | Request/response shapes for intelligence API endpoints |
| `actions.ts` | Pure functions: score computation, threshold evaluation, alert rule matching |
| `selectors.ts` | Derive health status labels, filter active alerts, rank concerns |
| `validators.ts` | Validate score ranges, confidence thresholds, prediction windows |
| `constants.ts` | Score thresholds, severity levels, alert cooldown periods, model versions |

## Constraints

- No I/O (no database, no HTTP, no file system)
- No framework imports (no Express, no Prisma)
- Pure TypeScript only — importable by API, web, or test code
