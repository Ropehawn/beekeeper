# BeeKeeper ESP32-C6 Node

Wireless ambient + weight sensor node. Reads a BME280 (temp/humidity/pressure)
over Qwiic/I²C **and** an HX711 load-cell amplifier over GPIO, then broadcasts
a single 20-byte BLE advertisement every 2 seconds. The `tachyon-hub` BLE
scanner decodes it and uploads readings to the BeeKeeper API.

## Hardware

- **ESP32-C6** (tested: SparkFun ESP32-C6 Qwiic Pocket, DEV-27196). Native USB-Serial/JTAG.
- **BME280** breakout on Qwiic / I²C (SparkFun SEN-15440 or equivalent).
  Default `0x77`, falls back to `0x76`.
- **HX711** load-cell amplifier (SparkFun SEN-13879) + 4× 50 kg half-bridge
  strain gauges in Wheatstone configuration (standard beehive scale wiring).
- **INMP441** digital MEMS microphone (I²S) — one or two per node for
  acoustic monitoring. *Firmware capture not yet implemented.*

### SparkFun ESP32-C6 Qwiic Pocket — pin assignments

| Role | GPIO | C6 pad | Notes |
|---|---|---|---|
| Qwiic SDA (BME280) | 6 | internal | do not steal — Qwiic bus |
| Qwiic SCL (BME280) | 7 | internal | do not steal — Qwiic bus |
| HX711 DT | 18 | `IO18` | data out of HX711 |
| HX711 SCK | 19 | `IO19` | clock from C6 |
| INMP441 BCLK | 2 | `IO2` | bit clock (C6 → mic) |
| INMP441 WS | 3 | `IO3` | word select / LRCLK (C6 → mic) |
| INMP441 SD | 4 | `IO4` | data (mic → C6) |
| Free | 5, 16, 17 | `IO5`, `TX`, `RX` | available for future sensors |

**GPIO 10–13, 22, 23 and others are not broken out on the Pocket** — don't
plan around them. GPIO 12/13 are USB D-/D+ (hardwired), 9 is the BOOT
button, 23 is the status LED.

### HX711 wiring

**Digital side (C6 → HX711):**

```
ESP32-C6 Pocket              SparkFun HX711 (SEN-13879)
──────────────               ──────────────────────────
 3V3    ────────────────────► VCC
 GND    ────────────────────► GND
 IO18   ◄──────────────────── DAT  (DOUT)
 IO19   ────────────────────► CLK
```

**Analog side — 4× 50 kg half-bridge load cells (each has RED/BLK/WHT):**

Arrange the cells at the 4 corners of the hive platform. Tie pairs:

| HX711 pad | Wire to |
|---|---|
| RED (E+) | all 4 cell RED wires tied together |
| BLK (E−) | all 4 cell BLACK wires tied together |
| GRN (A+) | WHITE from cells 1+2 (one side of platform) |
| WHT (A−) | WHITE from cells 3+4 (other side of platform) |
| YLW (shield) | leave unconnected, or tie to GND |

If readings go the wrong direction under load, swap GRN↔WHT.
If readings are zero, swap RED↔BLK.

Cleaner alternative: use a SparkFun Load Cell Combinator (SEN-14787), which
does the Wheatstone bridge wiring on a small PCB and outputs the 4 wires
you need.

### INMP441 mic wiring

INMP441 is **I²S digital audio**, not I²C or analog.

```
INMP441            ESP32-C6 Pocket
────────           ────────────────
 VDD    ◄───────── 3V3
 GND    ◄───────── GND
 L/R    ◄───────── GND        (mono / left channel)
 SCK    ◄───────── IO2        (BCLK)
 WS     ◄───────── IO3        (LRCLK / WS)
 SD     ─────────► IO4        (data into C6)
```

**For two mics on one C6 (stereo):** both share VDD/GND/SCK/WS/SD.
Mic #1 L/R → GND (fills left slot), mic #2 L/R → 3V3 (fills right slot).

Keep mic wiring under 30 cm and away from the HX711 cables — the HX711
pulls current in spikes that can couple into nearby wires.

## First-time setup on the Tachyon

```sh
ssh particle@192.168.1.146
cd /opt/beekeeper-hub        # or wherever you have the repo
./hardware/esp32-c6-node/scripts/install-arduino-cli.sh
```

This downloads `arduino-cli` into `~/.local/bin`, installs the `esp32:esp32`
core and the three required libraries (`Adafruit BME280 Library`,
`Adafruit Unified Sensor`, `NimBLE-Arduino`).

## Build & flash

With the C6 plugged into the Tachyon's USB port (enumerates as `/dev/ttyACM0`):

```sh
./hardware/esp32-c6-node/scripts/build-flash.sh /dev/ttyACM0
```

The script compiles for `esp32:esp32:esp32c6` and uses the chip's native USB
bootloader (RTS/DTR reset — no BOOT button needed).

## Serial commands (115200 baud on `/dev/ttyACM0`)

| Command | Purpose |
|---|---|
| `status` | Print current readings, calibration state, raw HX711 counts |
| `tare` | Zero the scale against the current (empty) load; persists to NVS |
| `cal <grams>` | With a known weight on the scale, set scale factor; persists |
| `reset` | Clear tare + calibration from NVS |

Example calibration flow:

```
status                          # confirm HX711 found
tare                            # empty scale
<place a 5000g reference>
cal 5000                        # tells node this weight is 5kg
status                          # verify scale factor saved
```

## BLE advertisement layout

Manufacturer Specific Data (AD type `0xFF`), **20 bytes**:

| Offset | Bytes | Field | Encoding |
|---|---|---|---|
| 0 | 2 | Company ID `0xFFFF` | uint16 LE (R&D / no-company) |
| 2 | 2 | Signature `"BK"` | `0x42 0x4B` |
| 4 | 1 | Protocol version | `0x02` (BME280 + HX711) |
| 5 | 1 | Node type | `0x01` = BME only, `0x02` = BME + HX711 |
| 6 | 2 | Temperature × 100 °C | int16 LE, `0x7FFF` = invalid |
| 8 | 2 | Humidity × 100 %RH | uint16 LE, `0xFFFF` = invalid |
| 10 | 3 | Pressure (Pa) | uint24 LE, `0xFFFFFF` = invalid |
| 13 | 4 | Weight (g) | int32 LE, `0x7FFFFFFF` = invalid |
| 17 | 1 | Battery % or `0xFF` if USB/unknown | uint8 |
| 18 | 1 | Flags | bit0=BME, bit1=HX711 present, bit2=HX711 calibrated, bit3=first-boot |
| 19 | 1 | Reserved | `0x00` |

**Before HX711 calibration**: bytes 13–16 contain raw HX711 counts, and flag
bit2 is clear. The hub parser emits this as `hx711_raw_counts` so you can
back-calibrate from the server if needed.

**After HX711 calibration**: bytes 13–16 contain signed grams, flag bit2 is
set, and the hub emits `weight_g` readings.

Total advertisement budget used: 3 (flags AD) + 2+5 (shortened name "BK-C6") +
2+20 (MSD AD) = 32 bytes. We stay at the 31-byte legacy-adv limit by NimBLE
automatically moving the name into the scan response if needed.

The hub parser lives in `../tachyon-hub/src/ble-scanner.js` —
`_parseBeeKeeperC6`.

## Registering the node with the hub

After flashing, read the BLE MAC (the base MAC minus `ff:fe` extension):

```sh
export PATH=~/.local/bin:$PATH
esptool --port /dev/ttyACM0 read-mac
```

Then provision via the API:

```sh
curl -s -X POST "https://beekeeper-api-production.up.railway.app/api/v1/hubs/devices/provision" \
  -H "X-Hub-Key: $HUB_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mac": "58:e6:c5:e5:b8:b4",
    "type": "beekeeper_c6",
    "name": "Hive 1 Ambient + Scale",
    "hiveId": "<hive-uuid>"
  }'
```

## Verifying end-to-end

1. Flash firmware, watch serial:
   ```sh
   sudo cat /dev/ttyACM0
   # expect: adv: T=23.45C H=52.30% P=101234Pa W=...g uptime=... flags=0x03
   ```
2. BLE scan from the Tachyon should show the advertisement:
   ```sh
   sudo timeout 10 bluetoothctl scan on | grep "BK-C6"
   ```
3. Hub logs should show `ble.bkc6.parsed` events once the MAC is registered.
4. API `/api/v1/hubs/ingest` rows land in `sensor_readings_raw` with metrics
   `temperature_c`, `humidity_pct`, `pressure_pa`, `weight_g` (or
   `hx711_raw_counts` pre-calibration), `battery_pct`, `rssi_dbm`.
