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
| `ble_ingestion_daemon.py` | Main BLE daemon — scan + parse + batch + upload + heartbeat |
| `camera_capture.py` | CSI camera capture daemon — IMX519 stills, R2 upload via API |
| `m1_panel.py` | M1 enclosure front RGB LED + user button driver |
| `provision_sensor.py` | CLI tool for per-sensor provisioning (`--c6` for ESP32-C6, default for SC833F) |
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

Three units, one per daemon:

- `./systemd/beekeeper-hub-py.service` — BLE ingestion (sensors)
- `./systemd/beekeeper-camera-py.service` — CSI camera capture (cameras)
- `./systemd/beekeeper-panel-py.service` — M1 front LED + user button

Plus two non-systemd config files for the panel daemon:
- `./logind.conf.d/50-beekeeper-panel.conf` — stops systemd-logind from shutting down the hub when the M1 button is pressed (the button shares the power-key input with the SoC)
- `./sudoers.d/beekeeper-panel` — narrow sudo for the long-press → hub-restart action

### Open: M1 RGB LEDs

The M1 enclosure has 3 RGB LEDs driven by an ADP8866 I²C controller at
address `0x27` on bus 1. **The panel daemon does NOT drive them.** Two
unfinished pieces:

1. The Particle Tachyon kernel does not include `leds-adp8860.ko` (which
   covers the ADP8866). Only `leds-adp5520` is shipped. Until that driver
   is compiled — out-of-tree against `linux-headers-particle`, or contributed
   to Particle's kernel build — there is no kernel-side LED control path.
2. There is no shipped device-tree overlay binding `compatible = "adi,adp8866"`
   to `0x27`. `tachyon-overlays` does not include one. We'd have to write it
   alongside the IMX519 camera overlays we already use.

Particle is actively soliciting community contributions for Linux-side
hardware bring-up on Ubuntu 24.04 (see the
[Ubuntu 24.04 thread](https://community.particle.io/t/ubuntu-24-04-on-tachyon-early-access-open-development/70503)) —
the `leds-adp8860` build + the M1 LED overlay is exactly that kind of work.

Reference for register-level sanity check (Muon/M404, not Tachyon):
[M1 Enclosure LED community thread](https://community.particle.io/t/m1-enclosure-led/70599).
Note from rickkas7 in that thread: LED4 = top status LED, LED5/LED6 = the
two user-button LEDs. (The Muon-specific `3V3_AUX` requirement does NOT
apply on Tachyon.)

The `/sys/class/leds/{red,green,blue}` entries are NOT the M1 LEDs —
they're the Tachyon SoM's onboard PMIC-PWM status indicator and are owned
by Particle's own daemon. The panel daemon must not write to them.

Install all of it once per hub:

```sh
# Systemd units
sudo cp ./systemd/beekeeper-hub-py.service     /etc/systemd/system/
sudo cp ./systemd/beekeeper-camera-py.service  /etc/systemd/system/
sudo cp ./systemd/beekeeper-panel-py.service   /etc/systemd/system/

# Photo buffer for camera daemon
sudo mkdir -p /var/lib/beekeeper && sudo chown particle:particle /var/lib/beekeeper

# Panel daemon: logind drop-in (button doesn't shut us down) + narrow sudo
sudo mkdir -p /etc/systemd/logind.conf.d
sudo cp ./logind.conf.d/50-beekeeper-panel.conf /etc/systemd/logind.conf.d/
sudo systemctl restart systemd-logind   # picks up the drop-in

sudo cp ./sudoers.d/beekeeper-panel /etc/sudoers.d/
sudo chmod 440 /etc/sudoers.d/beekeeper-panel
sudo visudo -c -f /etc/sudoers.d/beekeeper-panel   # syntax-check

# Panel daemon also needs python3-evdev
sudo apt-get install -y python3-evdev
# OR (in the venv): /home/particle/beekeeper-ai/bin/pip install evdev

sudo systemctl daemon-reload
sudo systemctl enable --now beekeeper-hub-py beekeeper-camera-py beekeeper-panel-py
sudo systemctl status beekeeper-hub-py beekeeper-camera-py beekeeper-panel-py
```

Operate:

```sh
# Live logs
sudo journalctl -u beekeeper-hub-py -f

# Restart after updating source in ~/beekeeper-ai/
sudo systemctl restart beekeeper-hub-py

# Check restart history (should stay low — bursts indicate trouble)
sudo systemctl show beekeeper-hub-py -p NRestarts
```

The unit has `Restart=always` with `RestartSec=10` and a rate-limit of 5
restarts per 10 minutes. `After=bluetooth.service network-online.target`
holds service start until BlueZ and the network are up at boot.

Verified behaviors (2026-04-23):
- `systemctl restart bluetooth` — daemon survives without restarting
- `kill -9` of daemon PID — systemd respawns after 10s
- Clean boot — daemon comes up after bluetooth + network are online

## Known quirks

- **D-Bus/BlueZ disconnects.** If BlueZ restarts or drops the daemon's D-Bus
  connection, the daemon logs `AccessDenied` errors indefinitely in its
  current form. `systemctl restart beekeeper-hub-py` clears it. Defensive
  reconnection is on the roadmap.
- **C6 auto-discovery.** Unregistered C6 nodes are ignored by the API-side
  `hubs/ingest` route until their MAC is provisioned. Use `provision_web.py`
  on port 5050 from the local network to assign hiveId/name.
