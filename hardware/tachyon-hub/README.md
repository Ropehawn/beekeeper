# BeeKeeper Tachyon Hub

Phase 1 firmware for the Particle Tachyon hub: BLE scanner → local SQLite buffer → HTTPS uploader to the BeeKeeper API.

## Components

| File | Role |
|---|---|
| `src/index.js` | Entry point — composes all modules, runs loops |
| `src/config.js` | Loads env + `/etc/beekeeper-hub/config.json` |
| `src/buffer.js` | SQLite store-and-forward buffer (7-day retention) |
| `src/ble-scanner.js` | Noble passive scan + per-vendor parsers (SC833F, S05T, generic) |
| `src/uploader.js` | Batch POST to `/api/v1/hubs/ingest` + heartbeat |
| `systemd/beekeeper-hub.service` | Systemd unit for auto-start |

## One-time install (run on Tachyon)

```bash
# 1. Clone code onto Tachyon
sudo mkdir -p /opt/beekeeper-hub
sudo chown particle:particle /opt/beekeeper-hub
rsync -av ./ particle@<tachyon-ip>:/opt/beekeeper-hub/

# 2. Install dependencies (on Tachyon)
cd /opt/beekeeper-hub
npm install --omit=dev

# 3. Grant Node.js raw network capability (for BLE)
sudo setcap cap_net_raw+eip $(readlink -f $(which node))

# 4. Create env file with hub key (obtained from POST /api/v1/hubs/register)
sudo mkdir -p /etc/beekeeper-hub
sudo tee /etc/beekeeper-hub/env > /dev/null <<EOF
BEEKEEPER_HUB_KEY=<paste-raw-key-here>
BEEKEEPER_API_URL=https://beekeeper-api-production.up.railway.app
EOF
sudo chmod 600 /etc/beekeeper-hub/env

# 5. Create data dir
sudo mkdir -p /var/lib/beekeeper-hub
sudo chown particle:particle /var/lib/beekeeper-hub

# 6. Install + enable systemd unit
sudo cp systemd/beekeeper-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now beekeeper-hub
sudo systemctl status beekeeper-hub
```

## Registering this hub

From any machine authenticated with a `queen`-role account:

```bash
curl -X POST https://beekeeper-api-production.up.railway.app/api/v1/hubs/register \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Norwalk apiary hub","platform":"tachyon","apiaryId":"<uuid>"}'
```

The response contains `apiKey` — shown **once**. Paste into `/etc/beekeeper-hub/env`.

## Device registry

The hub pulls its device map from `GET /api/v1/hubs/config`. Each entry:

```json
{
  "mac": "AA:BB:CC:DD:EE:01",
  "hiveId": "uuid-of-hive-1",
  "type": "sc833f",
  "vendor": "tachyon_ble_sc833f",
  "framePosition": null,
  "role": "primary",
  "name": "Hive 1 Primary"
}
```

Device registry is edited in the BeeKeeper admin UI (future), or directly in the DB on `hubs.device_registry` JSON column, then the hub picks up changes on next `fetchConfig()` call (next restart in Phase 1; live reload in later phase).

## Parser status

Phase 1 parsers are **RSSI-only placeholders** for SC833F and S05T. Once physical hardware arrives, the byte layout of each vendor's manufacturer-specific data will be finalized by sniffing with `bluetoothctl scan on` + `btmon` and the parsers updated in `src/ble-scanner.js`.

## Logs

```bash
journalctl -u beekeeper-hub -f
```

All output is structured JSON — pipe through `jq` for pretty formatting.

## Related

- Hardware architecture: `../HARDWARE_SPEC.md`
- Intelligence architecture: `../INTELLIGENCE_SPEC.md`
- API endpoints: `apps/api/src/routes/hubs.ts`
- DB migration: `packages/db/prisma/migrations/11_add_tachyon_hub_and_raw_readings/`
