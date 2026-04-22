# Tachyon Hub — Python ingestion daemon

Production-path BLE ingestion daemon that runs on a Particle Tachyon hub.
Continuously scans for BLE sensor advertisements, parses vendor-specific
payloads, batches readings, and uploads to the BeeKeeper API.

> Supersedes the Node.js scaffolding in `../tachyon-hub/` for live-hub work.
> The JS path's `ble-scanner.js` is still the canonical parser reference and
> doc source; this Python implementation mirrors its protocol handling.

## What runs on a deployed hub

| File | Purpose |
|---|---|
| `ble_ingestion_daemon.py` | Main daemon — scan + parse + batch + upload |
| `provision_sensor.py` | CLI tool for per-sensor provisioning (assigns a human-readable ID, MAC binding) |
| `provision_web.py` | Local web UI (port 5050) for provisioning from a phone |
| `raw_hci_scan.py` | One-shot BLE advertisement dumper for debugging |
| `hub-config.example.json` | Template config — copy to `hub-config.json`, fill in `hubId` + `apiKey` |

Runtime state files (not in git, live on each hub):

- `hub-config.json` — real hubId, apiKey, apiUrl (copy from `hub-config.example.json` and fill in)
- `sensor_registry.json` — provisioned sensor registry (human ID → MAC → events)
- `device_cache.json` — last-known MAC → API device UUID mapping
- `registry_backups/` — rotating snapshots of the registry
- `labels/` — generated QR-code PNGs from the provisioner

## Supported BLE payloads

Matches `../tachyon-hub/src/ble-scanner.js` — see that file for byte-by-byte
layouts. Protocol versions currently parsed:

- **Fanstel SC833F** — iBeacon format, company ID `0x0634`, Major=temp °C,
  Minor=humidity %RH
- **BeeKeeper C6 v0x02** — BME280 + HX711 (20 bytes)
- **BeeKeeper C6 v0x03** — v0x02 + INMP441 RMS/peak (22 bytes)
- **BeeKeeper C6 v0x04** — v0x03 + 4 FFT band energies (26 bytes)

## Install on a fresh Tachyon

```sh
# System packages
sudo apt update
sudo apt install -y python3-venv python3-pip bluetooth bluez libbluetooth-dev

# Clone the repo (pick a location you own)
git clone <repo-url> ~/beekeeper-repo
cd ~/beekeeper-repo/hardware/tachyon-hub-py

# Isolated venv for the hub runtime (lives outside the repo so deploys stay clean)
python3 -m venv ~/beekeeper-ai
source ~/beekeeper-ai/bin/activate
pip install bleak aiohttp

# Copy source + template config into the runtime dir
cp *.py ~/beekeeper-ai/
cp hub-config.example.json ~/beekeeper-ai/hub-config.json
# Edit ~/beekeeper-ai/hub-config.json — set hubId and apiKey (from POST
# /api/v1/hubs/register response)
```

Register the hub with the API first if not already:

```sh
curl -X POST "https://beekeeper-api-production.up.railway.app/api/v1/hubs/register" \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Tachyon-<site-name>"}'
# Response returns hubId + apiKey — put those into hub-config.json.
# The apiKey is shown ONCE.
```

## Run

### Foreground (for debugging)

```sh
cd ~/beekeeper-ai
./bin/python ble_ingestion_daemon.py
```

### Under systemd (production)

A unit file lives at `./systemd/beekeeper-hub-py.service` — see that file
for install instructions. Once enabled, `systemctl status beekeeper-hub-py`
and `journalctl -u beekeeper-hub-py -f` give you state and live logs.

## Known quirks

- **D-Bus/BlueZ disconnects.** If BlueZ restarts or drops the daemon's D-Bus
  connection, the daemon logs `AccessDenied` errors indefinitely in its
  current form. `systemctl restart beekeeper-hub-py` clears it. Defensive
  reconnection is on the roadmap.
- **C6 auto-discovery.** Unregistered C6 nodes are ignored by the API-side
  `hubs/ingest` route until their MAC is provisioned. Use `provision_web.py`
  on port 5050 from the local network to assign hiveId/name.
