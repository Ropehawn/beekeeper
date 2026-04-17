# @beekeeper/domain-inspections

Inspections domain package — types, validators, and selectors for inspection records, frame observations, frame photos, and AI analysis results.

## Scope

This package owns the **inspection lifecycle**: creating inspection records, recording per-frame observations, managing frame photos, and structuring AI analysis output.

| Owns | Does NOT own |
|------|-------------|
| Inspection record types | Hive structure (that's `hives`) |
| Frame observation schemas | Sensor data (that's `hardware`) |
| Frame photo metadata types | R2 storage operations (that's `apps/api`) |
| AI analysis result shapes | AI model invocation (that's `intelligence`) |
| Inspection validation rules | API route handlers (that's `apps/api`) |

## File Structure

| File | Purpose |
|------|---------|
| `types.ts` | Inspection, frame observation, frame photo, AI result interfaces |
| `api.ts` | Request/response shapes for inspection API endpoints |
| `actions.ts` | Pure functions: observation scoring, completeness checks |
| `selectors.ts` | Derive inspection status, overdue detection, history filtering |
| `validators.ts` | Validate inspection fields, frame percentages (sum to 100), date ranges |
| `constants.ts` | Frame types, observation categories, analysis confidence thresholds |

## Constraints

- No I/O (no database, no HTTP, no file system)
- No framework imports (no Express, no Prisma)
- Pure TypeScript only — importable by API, web, or test code
