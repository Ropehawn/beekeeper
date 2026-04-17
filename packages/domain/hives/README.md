# @beekeeper/domain-hives

Hives domain package — types, validators, and selectors for hive registry, component stacks, frame layout, and apiary configuration.

## Scope

This package owns the **hive structure**: the registry of hives, their physical component stacks (bottom board through outer cover), per-frame layout, and apiary-level configuration.

| Owns | Does NOT own |
|------|-------------|
| Hive registry types | Inspection records (that's `inspections`) |
| Component stack definitions | Sensor assignments (that's `hardware`) |
| Frame layout and numbering | Health scoring (that's `intelligence`) |
| Apiary configuration | Financial records (that's `apps/api`) |
| 3D model data shapes | 3D rendering (that's `apps/web`) |

## File Structure

| File | Purpose |
|------|---------|
| `types.ts` | Hive, component, frame, apiary interfaces |
| `api.ts` | Request/response shapes for hive API endpoints |
| `actions.ts` | Pure functions: stack ordering, component add/remove rules |
| `selectors.ts` | Derive hive status, frame counts, component filtering |
| `validators.ts` | Validate hive names, component ordering, frame numbering |
| `constants.ts` | Component types, default stack order, breed list, box capacities |

## Constraints

- No I/O (no database, no HTTP, no file system)
- No framework imports (no Express, no Prisma)
- Pure TypeScript only — importable by API, web, or test code
