# Tachyon Hub — Operational Status

**Last verified:** 2026-05-03 15:05 EDT
**Hub:** Tachyon-Rowayton (`d78065d7-7390-403b-851c-cb1be6e2708a`)
**Host:** `particle@192.168.1.146`

## Active services

| Unit | State |
|------|-------|
| `beekeeper-hub-py.service` | enabled, active (sole BLE ingestion path) |
| `beekeeper-ble.service` | **removed** — old pre-import unit deleted from `/etc/systemd/system/`, no longer registered |

Single daemon process (`ble_ingestion_daemon.py`). No more duplicate scans / duplicate uploads.

## Ingestion pipeline (verified)

- **Readings in last 10 min:** 66
- **`device_id` populated:** 66 / 66 (**100%**)
- **All-time `device_id` coverage:** 79,242 / 87,731 (90%) — pre-resolution backfill still pending
- **Daemon errors since restart:** zero
- **Heartbeat / upload cadence:** scan 60s, upload 300s, heartbeat 300s

## Sensors currently online

| Sensor ID | MAC | Vendor | Last seen |
|-----------|-----|--------|-----------|
| `BKC6A` | 58:E6:C5:E5:B8:B6 | `tachyon_ble_beekeeper_c6` | < 5 min |
| `CWBFS` | CF:66:52:74:C1:B2 | `tachyon_ble_sc833f` | < 5 min |
| `4AYHX` | F1:75:09:52:20:40 | `tachyon_ble_sc833f` | < 5 min |
| `GG6LB` | FA:8A:D8:C5:4E:CE | `tachyon_ble_sc833f` | < 5 min |

## C6 (`BKC6A`) — all 10 metrics parsing

| Domain | Metric | Sensor source |
|--------|--------|---------------|
| Environmental | `temperature_c`, `humidity_pct`, `pressure_pa` | BME280 |
| Audio (FFT) | `audio_peak_dbfs`, `audio_rms_dbfs`, `audio_band_low/midlow/midhigh/high_dbfs` | INMP441 |
| Weight | `hx711_raw_counts` | HX711 (currently `-1` — load cell not wired, expected) |

## Open issues

- ⚠ **`LZWCG` (E6:C1:83:2C:A6:3C) offline** — last reading 2026-05-02 23:56 UTC (~19 h ago). Needs physical check: battery (CR2032) and BLE range from Tachyon.

## Reproducing the verification

```bash
# daemon health
ssh particle@192.168.1.146 'sudo journalctl -u beekeeper-hub-py.service -n 30 --no-pager'

# DB ingestion
cd ~/Claud/beekeeping
DATABASE_URL=$(railway variables --json | jq -r '.DATABASE_URL' | sed 's/postgres.railway.internal:5432/interchange.proxy.rlwy.net:25954/') \
  node -e 'const{PrismaClient}=require("./packages/db");const db=new PrismaClient();
    db.sensorReadingRaw.count({where:{createdAt:{gte:new Date(Date.now()-10*60*1000)}}})
      .then(n=>console.log("last 10 min:",n)).then(()=>db.$disconnect())'
```
