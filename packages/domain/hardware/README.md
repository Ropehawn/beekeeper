# @beekeeper/domain-hardware

Hardware domain package — types, validators, and selectors for sensor devices, camera devices, hub registration, and BLE provisioning.

## Scope

This package owns the **device lifecycle**: discovery, registration, assignment to hives, polling configuration, and status tracking.

| Owns | Does NOT own |
|------|-------------|
| Sensor device types and validation | Sensor reading storage (that's `packages/db`) |
| Camera device types and validation | Video streaming (that's infrastructure) |
| Hub registration and provisioning | Alert logic (that's `intelligence`) |
| BLE MAC/QR provisioning flow | API route handlers (that's `apps/api`) |
| Polling interval configuration | Cron scheduling (that's `apps/api/jobs`) |

## File Structure

| File | Purpose |
|------|---------|
| `types.ts` | Device interfaces, registration payloads, discovery results |
| `api.ts` | Request/response shapes for hardware API endpoints |
| `actions.ts` | Pure functions: device registration logic, assignment rules |
| `selectors.ts` | Derive device status, filter active/inactive, group by hive |
| `validators.ts` | Validate device IDs, MAC addresses, poll intervals |
| `constants.ts` | Vendor names, default poll intervals, supported sensor types |

## Constraints

- No I/O (no database, no HTTP, no file system)
- No framework imports (no Express, no Prisma)
- Pure TypeScript only — importable by API, web, or test code
