# BeeKeeper Hardware — Prototype Specification

| Field | Value |
|-------|-------|
| Project | BeeKeeper Hardware |
| Author | ThomDigital Group LTD |
| Date | 2026-04-13 |
| Status | Draft — Phase 1 Prototype |
| Revision | 1.2 |

---

## 1. System Overview

### 1.1 Architecture

Hub-and-spoke topology. One Particle Tachyon per apiary acts as the central hub. Each hive has one or more BLE sensor nodes (spokes) that broadcast environmental data. The hub scans for BLE advertisements, aggregates readings, and pushes data to the BeeKeeper cloud API over WiFi or 5G.

```
                         ┌──────────────────────────────┐
                         │      BeeKeeper Cloud API     │
                         │  (Railway: Express + Prisma)  │
                         │  POST /api/v1/sensors/ingest  │
                         └──────────────┬───────────────┘
                                        │ HTTPS REST
                                        │
                    ┌───────────────────┴───────────────────┐
                    │         PARTICLE TACHYON HUB          │
                    │         (M1E IP67 Enclosure)          │
                    │                                       │
                    │  ┌─────────┐  ┌──────────┐  ┌──────┐ │
                    │  │ BLE 5.2 │  │ WiFi 6E  │  │  5G  │ │
                    │  │ Scanner │  │ Uplink   │  │ Fall │ │
                    │  └────┬────┘  └──────────┘  │ back │ │
                    │       │                      └──────┘ │
                    │  ┌────┴─────────────────────────────┐ │
                    │  │  CSI Camera 0     CSI Camera 1   │ │
                    │  │  (Hive 1 close)  (Hive 2 close)  │ │
                    │  └──────────────────────────────────┘ │
                    │  ┌──────────────────────────────────┐ │
                    │  │  GPIO: HX711 x 2 (weight, Ph1)  │ │
                    │  │  Audio: INMP441 x 2 (acoustics) │ │
                    │  │  Qwiic: BME280 (hub ambient)     │ │
                    │  └──────────────────────────────────┘ │
                    │  ┌──────────────────────────────────┐ │
                    │  │  12 TOPS NPU: bee counting,      │ │
                    │  │  varroa detection, entrance ML   │ │
                    │  └──────────────────────────────────┘ │
                    └───────┬──────────┬──────────┬────────┘
                            │ BLE      │ BLE      │ BLE
                   ┌────────┴───┐ ┌───┴────────┐ │
                   │  HIVE 1    │ │  HIVE 2    │ │  ... up to 10+
                   │            │ │            │ │
                   │ SC833F     │ │ SC833F     │ │  Primary BLE sensor
                   │ (temp,hum, │ │ (temp,hum, │ │
                   │  accel)    │ │  accel)    │ │
                   │            │ │            │ │
                   │ S05T x5-10 │ │ S05T x5-10 │ │  Optional thermal map
                   │ (frame     │ │ (frame     │ │
                   │  stickers) │ │  stickers) │ │
                   │            │ │            │ │
                   │ INMP441 mic│ │ INMP441 mic│ │  Phase 1: wired to hub
                   │ (acoustics)│ │ (acoustics)│ │
                   │            │ │            │ │
                   │ HX711+Load │ │ HX711+Load │ │  Phase 1: wired to hub
                   │ Cells(wire)│ │ Cells(wire)│ │
                   └────────────┘ └────────────┘ │
                                                  │
                   ┌──────────────────────────────┘
                   │  HIVE N (Phase 2)
                   │  Custom nRF52840 BLE Node
                   │  (temp, hum, weight, mic — all wireless)
                   └──────────────────────────────

    ALSO IN THE FIELD (independent network):

    ┌──────────────────────────┐
    │  UniFi Protect Camera(s) │──── UniFi CloudKey / UNVR ──── api.ui.com
    │  Wide-angle apiary view  │     (existing infrastructure)
    └──────────────────────────┘
              │
              └── BeeKeeper API already integrates via Cloud Connector
                  (see /apps/api/src/lib/unifi-client.ts)
```

### 1.2 Component Summary

| Component | Qty (2-hive proto) | Role |
|-----------|-------------------|------|
| Particle Tachyon (M1E) | 1 | Hub: BLE scanner, camera host, ML inference, cloud uplink |
| Fanstel SC833F | 2 | Primary per-hive: temp, humidity, 3-axis accelerometer (BLE) |
| MOKOSmart S05T (optional) | 10-20 | Per-frame thermal mapping stickers (BLE) |
| INMP441 MEMS mic | 2 | Per-hive: acoustic monitoring — swarm/queen detection (wired to Tachyon audio) |
| HX711 + 4x load cells | 2 sets | Per-hive: weight measurement (wired to Tachyon GPIO in Phase 1) |
| CSI Camera (IMX519) | 2 | Per-hive: entrance close-up, bee counting |
| BME280 breakout (Qwiic) | 1 | Hub ambient: outdoor temp/humidity/pressure baseline |
| UniFi Protect camera | 1-2 | Wide-angle apiary view (existing, separate network) |

---

## 2. Hub Unit (Tachyon + M1E)

### 2.1 Selected SKU

**Particle Tachyon M1E — 8GB RAM / 128GB eMMC**

The 8GB RAM is required for running on-device ML models concurrently with BLE scanning and dual-camera capture. The 128GB storage provides space for local image buffering, model weights, and edge data retention during network outages.

### 2.2 Tachyon Interfaces Used

| Interface | Pin/Connector | Connected To | Notes |
|-----------|--------------|-------------|-------|
| BLE 5.2 radio | Internal | SC833F + S05T sensors (passive scan) | Scans BLE advertisements, no pairing |
| WiFi 6E | Internal | Home/apiary WiFi AP | Primary uplink to BeeKeeper API |
| 5G modem | Internal SIM | Cellular fallback | Activates when WiFi unreachable |
| CSI Camera Port 0 | 4-lane MIPI CSI-2 | IMX519 (Hive 1) | 16MP, entrance monitoring |
| CSI Camera Port 1 | 4-lane MIPI CSI-2 | IMX519 (Hive 2) | 16MP, entrance monitoring |
| Qwiic / STEMMA QT | I2C (3.3V) | BME280 breakout | Daisy-chainable |
| Audio adapter port | 4-pin analog audio | INMP441 #1 + #2 (Hive 1 & 2 mics) | Wired via shielded cable alongside HX711, multiplexed or split via I2S HAT |
| GPIO 5, 6 | 40-pin HAT | HX711 #1 (Hive 1 weight) — DT, SCK | 3.3V logic |
| GPIO 13, 19 | 40-pin HAT | HX711 #2 (Hive 2 weight) — DT, SCK | 3.3V logic |
| GPIO 26 | 40-pin HAT | Status LED (optional) | Heartbeat |
| USB-C | Side panel | Debug/maintenance | Not used in production |

### 2.3 Hub Software Stack

The Tachyon runs Linux (Particle's Tachyon OS, Yocto-based). Hub firmware is a Node.js application:

1. **BLE Scanner Service** — Continuous passive scan for known BLE MACs, parses SC833F iBeacon data and S05T broadcast payloads, buffers readings
2. **Weight Poller Service** — Reads HX711 ADC via GPIO every 60s, applies tare offset and calibration factor
3. **Acoustic Monitor Service** — Records 10-second audio clips from INMP441 mics every hour (configurable). Runs audio classification on NPU for swarm preparation (200-500 Hz piping), queen presence (400-500 Hz tooting/quacking), and colony stress patterns. Stores last 48h of clips locally
4. **Camera Capture Service** — Takes snapshots from both CSI cameras every 5 min during daylight, runs ML inference, stores results locally
5. **Uplink Service** — Batches sensor readings and POSTs to BeeKeeper API via HTTPS. Store-and-forward when network unavailable. Retries with exponential backoff
6. **ML Inference Engine** — Uses 12 TOPS Qualcomm NPU for bee counting, varroa detection on captured frames, and audio classification for swarm/queen detection
7. **Local Watchdog** — Monitors all services, restarts on crash, logs to local storage

### 2.4 M1E Enclosure Modifications

All external connections must maintain IP67 rating.

| Penetration | Method | Purpose |
|-------------|--------|---------|
| 2x CSI camera ribbon cables | IP67 cable glands + silicone gaskets | External camera modules |
| 2x HX711 + INMP441 cables (6-wire combined) | IP67 PG7 cable glands | Weight + mic wiring (bundled per hive) |
| 1x power cable | Factory power entry or cable gland | Hub power supply |
| 1x WiFi antenna (if needed) | SMA bulkhead pass-through | Range extension (optional) |

---

## 3. Spoke Units (Per-Hive Sensors)

### 3.1 Phase 1 — Primary BLE Sensor: Fanstel SC833F

| Spec | Value |
|------|-------|
| Part | Fanstel SC833F |
| Dimensions | **30 x 31 x 10 mm** (coin-sized) |
| Weight | ~8g |
| Measurements | Temperature, humidity (AMS ENS210), 3-axis motion (ST LIS3DH) |
| BLE | **5.2** with 5.1 direction finding support |
| Broadcast | iBeacon + Eddystone, passive scan — no pairing required |
| Range | 3000m at 125 Kbps coded PHY (est. 100-200m real-world in apiary) |
| Battery | CR2032 coin cell, 1-2 year life |
| Price | **$12.97** at 1K qty, ~$20 at low qty |

**Why SC833F wins:**
- Smallest option at 30x31x10mm — fits easily inside a hive
- BLE 5.2 matches Tachyon's radio perfectly
- 3 sensors: temp + humidity + accelerometer (detects hive tipping/bear attacks/vandalism)
- Cheapest viable option at volume
- Standard CR2032 — cheap, replaceable everywhere
- Passive broadcast (iBeacon/Eddystone) — no connection overhead on Tachyon

**Placement:** One SC833F per hive, attached to the underside of the inner cover with Velcro or a small bracket. This position reads the temperature/humidity of the cluster's radiated heat rising through the frames.

**Trade-off vs RuuviTag:** No barometric pressure sensor. The BME280 on the hub provides ambient pressure for the entire apiary, which is sufficient since pressure doesn't vary between individual hives.

### 3.2 Phase 1 — Optional Add-On: MOKOSmart S05T Thermal Mapping

| Spec | Value |
|------|-------|
| Part | MOKOSmart S05T |
| Form factor | **Ultra-thin soft foam sticker** |
| Chipset | Silicon Labs BG22 (ultra-low power) |
| Measurements | Temperature only |
| Accuracy | +/-0.5C |
| Data storage | 60,000 readings onboard |
| Battery | Coin cell, 2-year life |
| IP rating | IP67 |
| BLE | BLE 5.0, broadcasts to gateways |
| Price | Est. $5-10 each at volume (OEM/ODM — contact MOKOSmart) |

**Use case:** Stick 5-10 S05T loggers directly onto frame top bars across the hive body. The Tachyon scans their BLE broadcasts to build a **real-time thermal map of the brood nest**:

```
    HIVE TOP VIEW — S05T Thermal Map (10 frames)

    ┌─────────────────────────────────────┐
    │  Frame 1  [S05T] ──── 28.1°C       │  Outer frame (cooler)
    │  Frame 2  [S05T] ──── 31.4°C       │
    │  Frame 3  [S05T] ──── 34.2°C       │  Brood nest edge
    │  Frame 4  [S05T] ──── 35.0°C       │  BROOD NEST
    │  Frame 5  [S05T] ──── 35.1°C       │  BROOD NEST (center)
    │  Frame 6  [S05T] ──── 35.0°C       │  BROOD NEST
    │  Frame 7  [S05T] ──── 34.8°C       │  Brood nest edge
    │  Frame 8  [S05T] ──── 32.1°C       │
    │  Frame 9  [S05T] ──── 29.5°C       │
    │  Frame 10 [S05T] ──── 27.8°C       │  Outer frame (cooler)
    └─────────────────────────────────────┘

    SC833F on inner cover reads: 33.2°C, 62% RH
    Hub BME280 ambient reads: 18.5°C, 45% RH
```

**What this enables:**
- Track brood nest expansion/contraction over time
- Detect queenlessness (brood temp drops below 34°C across all frames)
- Monitor cluster movement in winter
- Identify which frames have capped brood (tighter 34.5-35.5°C) vs honey stores (ambient)
- **No other consumer beekeeping product offers per-frame thermal mapping**

**Note:** MOKOSmart is OEM/ODM — ordering requires contacting them directly. MOQ likely 100+ units. For the prototype, order a small batch for evaluation.

### 3.3 Phase 2 — Custom nRF52840 BLE Sensor Node

The custom node integrates all per-hive sensing into a single wireless PCB, replacing both the SC833F and the wired HX711.

| Component | Part | Interface | Purpose |
|-----------|------|-----------|---------|
| MCU | Nordic nRF52840 (MDBT50Q-1MV2) | — | BLE 5.2 SoC, 1.5uA deep sleep |
| Temp/Humidity/Pressure | Bosch BME280 | I2C (0x76) | Environmental sensing |
| Weight ADC | HX711 | GPIO (DT + SCK) | 24-bit ADC for load cells |
| Load cells | 4x 50kg bar (CZL635) | Wheatstone bridge | Hive weight |
| Microphone | INMP441 MEMS | I2S | Acoustics (swarm, queen piping) |
| Battery charger | TP4056 module | USB-C | LiPo charging |
| Battery | 18650 LiPo 3400mAh (NCR18650B) | — | Power supply |
| Voltage regulator | AP2112K-3.3 | — | 3.3V LDO |
| Enclosure | 3D-printed PETG, IP65 | — | Weather protection |

**Power budget:**

| State | Current | Duration | Duty Cycle |
|-------|---------|----------|------------|
| Deep sleep | 1.5 uA | ~59s/min | 98.3% |
| BME280 read | 3.6 mA | 10ms | — |
| HX711 read | 1.5 mA | 100ms | — |
| INMP441 sample (1s burst) | 1.4 mA | 1000ms | — |
| BLE TX (advertisement) | 7 mA | 5ms | — |
| **Weighted average** | **~35 uA** | — | — |

At 35uA average from 3400mAh cell: **3-6 months between charges**. Optional 1W solar panel + TP4056 for indefinite operation (~$8 add-on).

---

## 4. Sensor Matrix

| Measurement | Sensor | Interface | Location | Accuracy | Update Rate | Phase |
|-------------|--------|-----------|----------|----------|-------------|-------|
| Hive internal temp | SC833F (Ph1) / BME280 on nRF52840 (Ph2) | BLE adv | Inner cover | +/-0.3C | Configurable (1-10s) | 1/2 |
| Hive internal humidity | SC833F / BME280 | BLE adv | Inner cover | +/-3% RH | Configurable | 1/2 |
| Hive tilt/vibration | SC833F accelerometer (LIS3DH) | BLE adv | Inner cover | — | Configurable | 1 |
| Per-frame temperature | S05T stickers (optional) | BLE adv | Frame top bars | +/-0.5C | Configurable | 1 |
| Hive weight | HX711 + 4x 50kg load cells | GPIO wired (Ph1) / nRF52840 wireless (Ph2) | Under bottom board | +/-50g | Every 60s | 1/2 |
| Ambient temp/humidity/pressure | BME280 (Qwiic) | I2C | Hub enclosure | +/-0.5C / +/-3% RH / +/-1 hPa | Every 60s | 1 |
| Hive acoustics | INMP441 MEMS mic | Wired to Tachyon audio (Ph1) / I2S on nRF52840 (Ph2) | Under inner cover | 58 dBFS SNR | 10s recording every hour | **1**/2 |
| Entrance video | IMX519 CSI camera | MIPI CSI | Hive entrance | 16MP | Every 5 min (stills) | 1 |
| Apiary overview | UniFi Protect camera | Cloud Connector API | Pole-mounted | Varies by model | Continuous | 1 |
| Sensor battery | SC833F / S05T internal | BLE adv | On sensor | +/-10mV | Every broadcast | 1 |
| BLE signal strength | Tachyon RSSI | BLE scan | Hub side | +/-6 dBm | Every scan | 1 |

---

## 5. Weight System Design

### 5.1 Load Cell Configuration

Four 50kg bar-type load cells (CZL635) in full Wheatstone bridge. Total capacity: 200kg (440 lbs).

```
    TOP VIEW — Load Cell Platform
    ┌─────────────────────────────┐
    │                             │
    │   [LC1]              [LC2]  │    LC = Load Cell (50kg bar type)
    │    /                    \   │
    │   /    HIVE SITS HERE    \  │    Total capacity: 200kg (440 lbs)
    │   \                      /  │    Typical hive: 30-90 kg (65-200 lbs)
    │    \                    /   │
    │   [LC3]              [LC4]  │
    │                             │
    └─────────────────────────────┘

    SIDE VIEW — Platform Assembly
    ┌─────────────────────────────┐  <- Hive bottom board
    │         HIVE BODY           │
    └─────────────────────────────┘
    ┌─────────────────────────────┐  <- Top plate (3/4" marine plywood)
    │ [LC1]                [LC2]  │  <- Load cells (4x, wired in bridge)
    └─────────────────────────────┘
    ┌─────────────────────────────┐  <- Bottom plate (3/4" marine plywood)
    │         HIVE STAND          │
    └─────────────────────────────┘
```

### 5.2 HX711 Wiring (Phase 1 — Wired to Tachyon)

Each hive has one HX711 breakout at the hive stand, connected to the Tachyon via 4-wire shielded cable (3-5 meters).

**HX711 to Load Cell Bridge:**

| HX711 Pin | Connection |
|-----------|------------|
| E+ | Red (Excitation +) |
| E- | Black (Excitation -) |
| A+ | White (Signal +, Channel A) |
| A- | Green (Signal -, Channel A) |
| VCC | 3.3V from Tachyon GPIO header pin 1 |
| GND | GND from Tachyon GPIO header pin 6 |
| DT (Data) | GPIO 5 (Hive 1) or GPIO 13 (Hive 2) |
| SCK (Clock) | GPIO 6 (Hive 1) or GPIO 19 (Hive 2) |

**Cable:** 4-conductor shielded (Belden 8723), 22 AWG, foil shield grounded at Tachyon end only. Max 5m — longer runs introduce HX711 noise.

### 5.3 Calibration

1. **Tare:** Empty platform, read 100 samples, average = `tareOffset`
2. **Two-point:** Place known weight (20 kg), read 100 samples. `calibrationFactor = knownWeight / (rawReading - tareOffset)`
3. **Verify:** Second known weight, confirm +/-50g accuracy
4. **Storage:** `tareOffset` and `calibrationFactor` in hub config + synced to BeeKeeper API sensor device config JSON
5. **Re-calibrate:** Monthly or when platform repositioned. "Calibrate Scale" button in app

### 5.4 Phase 2 (Wireless)

HX711 soldered onto custom nRF52840 PCB. Load cell wiring is local (under hive, no long cable run). Weight value included in BLE advertisement payload.

---

## 6. Camera System

### 6.1 UniFi Protect (Wide-Angle Apiary View)

Already integrated in BeeKeeper app via `/apps/api/src/lib/unifi-client.ts`. No hardware changes needed.

| Camera | Use Case | Price |
|--------|----------|-------|
| UniFi G4 Bullet | Apiary overview, weatherproof | ~$110 |
| UniFi G5 Flex | Secondary angle, compact | ~$90 |

### 6.2 CSI Cameras (Per-Hive Close-Up)

| Spec | Value |
|------|-------|
| Module | Arducam IMX519 16MP autofocus (B0371) |
| Interface | MIPI CSI-2, 4-lane |
| Resolution | 4656 x 3496 (16MP stills), 1080p30 video |
| Autofocus | PDAF + CDAF, 8cm to infinity |
| FoV | 84.5 degrees diagonal |
| Connector | 22-pin FPC |
| Price | ~$25 each |

**Mounting:** 3D-printed weatherproof housing, pointed at hive entrance from ~15-20cm. FPC ribbon cable to M1E through cable gland. For runs >30cm, use Arducam CSI-to-HDMI extension kit (~$20).

### 6.3 On-Device ML Models

Run on the 12 TOPS Qualcomm Hexagon DSP. Models quantized to INT8 (ONNX format). Backbones: MobileNetV3 or YOLOv8n.

| Model | Purpose | Input | Output | Est. Inference | Runtime |
|-------|---------|-------|--------|---------------|---------|
| Bee counter | Detect + track bees in/out | 1080p60 video burst (120 sampled frames) | In/out/net count per burst | **~2-10ms/frame** | Hexagon NPU (INT8) |
| Varroa detector | Detect varroa mites on bees | Cropped 224x224 regions from detections | Probability score per bee | ~5ms/crop | Hexagon NPU (INT8) |
| Swarm detector | Detect clustering/bearding | 1080p frame | Boolean + confidence | ~2-10ms | Hexagon NPU (INT8) |
| Entrance anomaly | Dead bees, robbing, wasps | 1080p frame | Classification + bboxes | ~2-10ms | Hexagon NPU (INT8) |
| Swarm audio | Detect piping/tooting (200-500 Hz) | 10s audio clip (16kHz mono) | Swarm probability + queen status | ~30ms | Hexagon NPU (INT8) |
| Queen detector | Tooting (virgin queen) vs quacking (caged queen) | 10s audio clip (16kHz mono) | Queen present/absent/virgin/mated | ~30ms | Hexagon NPU (INT8) |

**Capture strategy — Video Burst Mode:**

The IMX519 supports 1080p60 which is critical for bee counting — bees move too fast for reliable counting at 30fps stills alone. The pipeline uses short video bursts rather than individual snapshots:

| Parameter | Value |
|-----------|-------|
| Capture mode | 10-second video burst @ 1080p60 |
| Capture interval | Every 5 minutes during daylight (sunrise-sunset by GPS/date) |
| Frames per burst | ~600 (10s x 60fps) |
| Frames processed | ~120 (every 5th frame sampled) |
| Model | YOLOv8n INT8 quantized, fine-tuned on bee training data |
| Inference per frame | ~2-10ms on Hexagon 770 NPU |
| Tracking | ByteTrack/DeepSORT across frames for in/out counting |
| Total pipeline time | ~2-3 seconds per 10s burst |
| Storage | Last 24h of video clips stored locally (128GB = ~days of 1080p clips) |

**NPU Performance (validated):** A Hackster.io project demonstrated **2ms per frame** YOLO inference on Tachyon's Hexagon 770 NPU using INT8 quantization via Qualcomm AI Engine Direct (QNN). At 12 TOPS, the NPU handles object detection with headroom to spare.

**INT8 quantization note:** INT8 can reduce accuracy for small objects. Mitigations: (1) 1080p60 gives more pixels per bee, (2) camera mounted 15-20cm from entrance so bees fill the frame, (3) fine-tune YOLOv8n on bee-specific training data from your own hives.

**Data flow:** ML results (bee counts, detections, anomalies) pushed to API each cycle. Raw video is NOT pushed (bandwidth). On-demand retrieval of clips when anomalies detected or user requests playback.

---

## 7. Power Design

### 7.1 Hub Power

Tachyon draw: 8-12W typical, 15-18W peak (dual camera + ML inference).

**Option A: AC Power (prototype)**

| Component | Price |
|-----------|-------|
| Outdoor weatherproof outlet box | ~$25 |
| USB-C PD 65W charger (Anker) | ~$30 |
| USB-C cable 2m through gland | ~$10 |

**Option B: Solar (remote apiaries)**

| Component | Price |
|-----------|-------|
| Renogy 50W 12V mono panel | ~$60 |
| Renogy Wanderer 10A PWM controller | ~$20 |
| 12V 20Ah LiFePO4 battery | ~$80 |
| 12V to 5V 5A DC-DC buck (USB-C PD trigger) | ~$12 |

Solar budget in Norwalk CT: 50W panel x 3.5 peak sun hours = ~175Wh/day. Consumption at 10W avg = ~240Wh/day. **Marginal in winter. Sufficient April-October.** For year-round, upgrade to 100W panel.

**Option C: Battery Backup (recommended add-on for all setups)**

Ensures hub survives power outages and continues logging sensor data + audio clips. Inspired by Bee Army's built-in 7.2Ah gateway battery.

| Component | Spec | Price |
|-----------|------|-------|
| 12V 7.2Ah LiFePO4 battery | TalentCell YB1207200-USB | ~$45 |
| 12V to 5V 5A USB-C PD trigger board | DC-DC buck converter | ~$12 |
| Low-voltage cutoff module | Prevents deep discharge below 10V | ~$5 |

Runtime on battery: 7.2Ah x 12V = 86.4Wh. At 10W avg draw = **~8.5 hours of autonomy**. At reduced power mode (BLE + weight only, cameras off) ~5W = **~17 hours**. Can be paired with AC (Option A) for UPS-style failover, or with solar (Option B) for full off-grid.

### 7.2 Spoke Power

| Sensor | Battery | Life |
|--------|---------|------|
| Fanstel SC833F | CR2032 coin cell | 1-2 years |
| MOKOSmart S05T | Coin cell (built-in) | ~2 years |
| Custom nRF52840 (Phase 2) | 18650 LiPo 3400mAh | 3-6 months (rechargeable USB-C) |

---

## 8. Communication Architecture

### 8.1 BLE Scanning Strategy

Tachyon runs continuous passive BLE scan. No connections established — hub listens to advertisements only.

**Scan parameters:**
- Scan window: 30ms
- Scan interval: 40ms (75% duty cycle)
- Filter: Known MAC addresses from device registry
- Parse: SC833F iBeacon/Eddystone payloads + S05T broadcast data

**Device registry** (local JSON, synced from BeeKeeper API):

```json
{
  "devices": [
    {
      "mac": "AA:BB:CC:DD:EE:01",
      "hiveId": "uuid-of-hive-1",
      "type": "sc833f",
      "role": "primary",
      "name": "Hive 1 Primary"
    },
    {
      "mac": "AA:BB:CC:DD:EE:10",
      "hiveId": "uuid-of-hive-1",
      "type": "s05t",
      "role": "thermal_map",
      "framePosition": 1,
      "name": "Hive 1 Frame 1"
    }
  ]
}
```

### 8.2 Data Flow

```
BLE Sensors (SC833F every ~2s, S05T configurable)
    |
    v
Tachyon BLE Scanner (parses advertisements)
    |
    v
Local Buffer (ring buffer, last 60 readings per device)
    |
    v  (every 60 seconds, configurable)
Aggregation: compute min/max/avg over buffer window
    |
    v
POST https://beekeeper-api.../api/v1/sensors/ingest
    |
    Headers: X-Hub-Key: <hub-api-key>
    Body: {
      hubId: "tachyon-uuid",
      readings: [
        {
          deviceMac: "AA:BB:CC:DD:EE:01",
          hiveId: "uuid",
          type: "sc833f",
          tempF: 95.2,
          humidity: 62.4,
          accelX: 0.01,
          accelY: -0.02,
          accelZ: 9.81,
          batteryV: 2.95,
          rssi: -42,
          recordedAt: "2026-04-13T14:30:00Z"
        },
        {
          deviceMac: "AA:BB:CC:DD:EE:10",
          hiveId: "uuid",
          type: "s05t",
          role: "thermal_map",
          framePosition: 1,
          tempF: 91.4,
          rssi: -38,
          recordedAt: "2026-04-13T14:30:00Z"
        }
      ]
    }
    |
    v
BeeKeeper API: validates, writes to sensor_readings
    |
    v
(Future) Redis pub/sub -> WebSocket broadcast to browsers
```

### 8.3 Protocol Choice

**HTTPS REST for Phase 1.** At 1 POST per minute per hub, HTTPS is adequate. MQTT becomes worthwhile at Phase 3 (dozens of hubs). Migration path: Tachyon firmware switches from HTTP POST to MQTT publish, API adds MQTT-to-REST bridge.

### 8.4 Offline / Store-and-Forward

When Tachyon can't reach the API:

1. Readings accumulate in local SQLite on 128GB storage
2. Connectivity check every 30 seconds
3. On reconnection, buffered readings uploaded in chronological batches (100/POST)
4. SQLite rows deleted after successful upload (HTTP 200/201)
5. Max local retention: 7 days (~10,000 readings/device). Oldest dropped after that

---

## 9. Bill of Materials

### 9.1 Phase 1 BOM — 2-Hive Prototype

| Item | Part | Qty | Unit $ | Total |
|------|------|-----|--------|-------|
| **Hub** | | | | |
| Particle Tachyon M1E (8GB/128GB) | Particle Store | 1 | $249 | $249 |
| BME280 Qwiic breakout | SparkFun SEN-15440 | 1 | $14 | $14 |
| Qwiic cable 200mm | SparkFun PRT-14427 | 1 | $2 | $2 |
| USB-C PD 65W charger | Anker A2668 | 1 | $30 | $30 |
| USB-C cable 2m | Amazon | 1 | $12 | $12 |
| IP67 cable glands PG7 (10-pack) | Amazon | 1 | $8 | $8 |
| **Primary BLE Sensors (x2)** | | | | |
| Fanstel SC833F | fanstel.com | 2 | $20 | $40 |
| CR2032 batteries (10-pack) | Amazon | 1 | $6 | $6 |
| **Optional: Thermal Map Stickers (x10)** | | | | |
| MOKOSmart S05T | MOKOSmart (contact) | 10 | $8 (est) | $80 |
| **Weight Sensors (x2 hives)** | | | | |
| HX711 load cell amplifier | SparkFun SEN-13879 | 2 | $10 | $20 |
| 50kg load cell bar (CZL635) | Amazon/AliExpress | 8 | $4 | $32 |
| Load cell platform plates (3/4" marine ply 18"x22") | Lumber yard | 4 | $8 | $32 |
| 6-conductor shielded cable 5m (22AWG) | Belden 8723 | 2 | $8 | $16 |
| **Acoustic Sensors (x2 hives)** | | | | |
| INMP441 MEMS microphone breakout | Adafruit / Amazon | 2 | $3 | $6 |
| 3D-printed mic housing (IP65, vented) | PLA/PETG | 2 | $2 | $4 |
| **Cameras (x2 hives)** | | | | |
| Arducam IMX519 16MP autofocus | Arducam B0371 | 2 | $25 | $50 |
| CSI FPC extension cable 50cm | Arducam / Amazon | 2 | $6 | $12 |
| 3D-printed camera housing | PLA/PETG | 2 | $3 | $6 |
| **Misc** | | | | |
| Weatherproof outlet box | Home Depot | 1 | $25 | $25 |
| Mounting hardware | — | 1 | $15 | $15 |
| Silicone sealant | Permatex 80050 | 1 | $8 | $8 |
| **Battery Backup (recommended)** | | | | |
| 12V 7.2Ah LiFePO4 battery | TalentCell YB1207200-USB | 1 | $45 | $45 |
| 12V to 5V USB-C PD buck converter | Amazon | 1 | $12 | $12 |
| Low-voltage cutoff module | Amazon | 1 | $5 | $5 |
| | | | | |
| **Subtotal (full build + thermal map)** | | | | **$725** |
| **Subtotal (full build, no thermal map)** | | | | **$645** |
| **Subtotal (no thermal map, no battery)** | | | | **$583** |
| **Contingency (15%)** | | | | **$97** |
| **Phase 1 Total (full build + thermal map)** | | | | **$822** |
| **Phase 1 Total (full build, no thermal map)** | | | | **$742** |

### 9.2 Phase 1 — Per Additional Hive (scaling to 10+)

| Item | Cost |
|------|------|
| Fanstel SC833F | $20 |
| HX711 + 4x load cells + platform | $52 |
| INMP441 mic + housing | $5 |
| 6-conductor cable 5m | $8 |
| S05T x 5-10 (optional) | $40-80 |
| CSI camera + cable + housing | $34 |
| **Per hive (without thermal map)** | **$119** |
| **Per hive (with thermal map)** | **$159-199** |

Note: CSI cameras limited by Tachyon's 2 CSI ports. For >2 hives, use USB cameras or skip per-hive cameras (rely on UniFi Protect only).

### 9.3 Phase 2 BOM — Custom nRF52840 Node (per node)

| Item | Part | Qty | Unit $ | Total |
|------|------|-----|--------|-------|
| MDBT50Q-1MV2 (nRF52840 module) | DigiKey | 1 | $8 | $8 |
| BME280 (QFN IC) | DigiKey | 1 | $4 | $4 |
| HX711 (SOP-16 IC) | LCSC | 1 | $1.50 | $1.50 |
| INMP441 MEMS mic | LCSC | 1 | $2 | $2 |
| TP4056 USB-C charger | AliExpress | 1 | $1 | $1 |
| AP2112K-3.3 LDO | DigiKey | 1 | $0.50 | $0.50 |
| 18650 holder + NCR18650B cell | 18650BatteryStore | 1 | $7 | $7 |
| Custom PCB (JLCPCB, amortized) | JLCPCB | 1 | $2 | $2 |
| Passives (caps, resistors, LEDs) | — | 1 | $2 | $2 |
| 3D-printed IP65 enclosure | PETG | 1 | $5 | $5 |
| **Phase 2 per-node total** | | | | **~$33** |

Replaces SC833F ($20) + eliminates wired HX711 cabling. Adds weight + acoustics wirelessly.

---

## 10. Software Integration

### 10.1 New Vendor Values for SensorDevice

| Vendor String | Device Type |
|---------------|------------|
| `tachyon_ble_sc833f` | Fanstel SC833F primary sensor |
| `tachyon_ble_s05t` | MOKOSmart S05T thermal map sticker |
| `tachyon_ble_custom` | Phase 2 custom nRF52840 node |
| `tachyon_gpio` | HX711 wired weight sensor |
| `tachyon_csi` | CSI camera ML inference results |
| `unifi_protect` | Existing, unchanged |

### 10.2 New API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/sensors/ingest` | POST | Batch upload readings from Tachyon hub |
| `/api/v1/sensors/hub/register` | POST | Register a Tachyon hub + BLE device map |
| `/api/v1/sensors/hub/:id/config` | GET | Hub pulls its config (devices, calibration, schedule) |
| `/api/v1/sensors/hub/:id/heartbeat` | POST | Hub liveness (uptime, storage free, CPU temp) |
| `/api/v1/cameras/tachyon/inference` | POST | Upload ML inference results (bee counts) |
| `/api/v1/cameras/tachyon/:hiveId/snapshot` | GET | Retrieve latest CSI snapshot on demand |

**Auth:** Per-hub API key in `X-Hub-Key` header. Key generated in BeeKeeper admin UI, stored as env var on Tachyon. Validated server-side.

### 10.3 SensorDevice Config JSON

```json
{
  "type": "tachyon_ble_sc833f",
  "mac": "AA:BB:CC:DD:EE:01",
  "hubId": "tachyon-uuid",
  "role": "primary",
  "calibration": {
    "tareOffset": 8234567,
    "calibrationFactor": 420.5,
    "calibratedAt": "2026-04-18T10:00:00Z"
  },
  "captureSchedule": {
    "sensorIntervalSec": 60,
    "cameraIntervalSec": 300,
    "cameraActiveHours": { "start": "06:00", "end": "20:00" }
  }
}
```

For S05T thermal map sensors, additional field:

```json
{
  "type": "tachyon_ble_s05t",
  "mac": "AA:BB:CC:DD:EE:10",
  "hubId": "tachyon-uuid",
  "role": "thermal_map",
  "framePosition": 1
}
```

### 10.4 New Alert Rules

| Rule | Trigger | Severity | Cooldown |
|------|---------|----------|----------|
| `weight_drop_sudden` | Weight drops > 2 kg in < 1 hour | critical | 24h |
| `weight_drop_gradual` | Weight drops > 5 kg over 7 days (not harvest) | warning | 7 days |
| `temp_cluster_cold` | Internal temp < 10C for > 2 hours | critical | 48h |
| `temp_cluster_hot` | Internal temp > 40C for > 1 hour | warning | 24h |
| `humidity_high` | Humidity > 80% for > 4 hours | warning | 7 days |
| `hive_tilt` | Accelerometer detects >15 degree tilt change | critical | 1h |
| `battery_low` | Sensor battery < 2.5V | warning | 7 days |
| `sensor_offline` | No reading for > 30 minutes | warning | 24h |
| `bee_count_anomaly` | Entrance traffic drops > 70% vs 7-day avg | warning | 48h |
| `brood_temp_anomaly` | S05T thermal map shows no frames at 34-35.5C | warning | 48h |
| `swarm_audio_detected` | Audio ML detects piping/tooting pattern (200-500 Hz) | critical | 24h |
| `queen_status_change` | Audio ML detects queen loss or virgin queen piping | critical | 48h |

### 10.5 Key Files to Modify

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | New vendor enum values, hub registration model |
| `apps/api/src/routes/sensors.ts` | New `/ingest`, `/hub/*` endpoints |
| `apps/api/src/lib/tachyon-client.ts` | **New** — Hub config management, reading validation |
| `apps/api/src/jobs/alert-notifications.ts` | New alert rules for weight, tilt, thermal map |
| `docs/V2_SCHEMA_EVOLUTION.md` | Update to reference Tachyon hardware integration |

---

## 11. Enclosure and Mounting

### 11.1 Hub Placement

Tachyon M1E mounted on a post or structure near apiary center, elevated 1.5-2m for BLE range and camera sightlines.

```
    APIARY LAYOUT — Norwalk CT, south side of stonewall

    ============================================  <- Stonewall (north)
    [UniFi Protect camera on wall, looking south]

       +---------+    +----------+    +---------+
       | Hive 1  |    | TACHYON  |    | Hive 2  |
       |   ^ SE  |    |   HUB    |    |   ^ SE  |
       +---------+    | (post)   |    +---------+
          |           +----------+          |
          | ~3m wire       | power    ~3m wire |
          | (HX711+mic)    | (AC)   (HX711+mic)|
          +----------------+-----------------+

       Entrances facing southeast ^
```

### 11.2 Per-Hive Mounting

| Component | Method | Location |
|-----------|--------|----------|
| SC833F | Velcro to inner cover frame | Under outer cover, above inner cover |
| S05T stickers | Adhesive foam on frame top bars | One per frame across hive body |
| Load cell platform | Sits on hive stand | Under bottom board |
| INMP441 mic | 3D-printed vented housing, zip-tied to bottom board | Under hive, pointing up through screened bottom |
| HX711 breakout | IP65 junction box on stand leg | At base of each hive |
| CSI camera | 3D-printed bracket on stand | Facing entrance, 15-20cm away |
| Camera cable | UV-rated cable conduit | Camera housing to hub |

### 11.3 Seasonal (Norwalk CT)

| Season | Concern | Mitigation |
|--------|---------|------------|
| Winter (-15C) | Tachyon temp | M1E rated to -20C |
| Winter | SC833F battery | CR2032 rated to -30C |
| Summer (35C+) | Hub heat | M1E passive dissipation. Add 5V fan if throttling |
| Rain/Snow | All outdoor | IP67 hub, IP65+ junction boxes, sealed camera housing |
| Pests | Cable chewing | UV-rated conduit, diatomaceous earth at entry points |

---

## 12. Phased Roadmap

### Phase 1 — Prototype (April - June 2026)

| Week | Milestone |
|------|-----------|
| 1 | Order: Tachyon M1E, SC833F x2, HX711 kits, load cells, IMX519 cameras. Contact MOKOSmart for S05T samples |
| 2 | Build load cell platforms, test HX711 on bench |
| 3 | Tachyon arrives. Flash firmware. Test BLE scanning with SC833F indoors |
| 4 | Wire HX711 to Tachyon GPIO. Calibrate with known weights |
| 5 | Connect CSI cameras. Test capture and basic ML inference |
| 6 | Implement `POST /api/v1/sensors/ingest` on BeeKeeper API |
| 7 | Deploy to apiary. Mount hub, cameras, platforms. Connect power |
| 8 | End-to-end validation. S05T thermal map integration if samples arrive |

**Deliverables:**
- Tachyon hub operational at apiary
- 2x SC833F broadcasting temp/humidity/accel to BeeKeeper app
- 2x HX711 weight readings in BeeKeeper app
- 2x CSI camera snapshots in BeeKeeper app
- Store-and-forward working
- Basic bee counter ML model on-device
- 2x INMP441 mics recording 10s audio clips hourly, swarm/queen ML detection
- Battery backup providing ~8.5h autonomy during power outages
- (Optional) S05T per-frame thermal map visualization

### Phase 2 — Custom BLE Nodes (July - September 2026)

| Task | Duration |
|------|----------|
| nRF52840 PCB design (KiCad) | 2 weeks |
| PCB fabrication (JLCPCB) | 2 weeks |
| Assembly and bring-up | 1 week |
| Firmware (Zephyr RTOS) | 3 weeks |
| Custom BLE payload design | 1 week |
| Tachyon firmware update for custom payload | 1 week |
| Field testing and calibration | 2 weeks |

**Deliverables:**
- 2x custom nRF52840 nodes: wireless weight + temp/humidity + acoustics
- Remove wired HX711 cables
- Audio-based swarm detection alerts
- Battery-powered, USB-C rechargeable

### Phase 3 — Productize (October 2026 - March 2027)

| Task | Notes |
|------|-------|
| Multi-hub support | Hub registration, fleet management, per-hub auth |
| MQTT broker | Replace REST with MQTT pub/sub for scale |
| Custom PCB rev 2 | Address Phase 2 issues, conformal coating |
| Injection-molded enclosures | Replace 3D-printed housings |
| Tachyon OTA updates | Remote firmware updates |
| ML model improvements | Train on accumulated Phase 1-2 data |
| Hardware Setup Wizard | Guided onboarding in BeeKeeper web app |
| FCC/CE certification | Required for commercial sale of custom radio devices |
| BOM optimization (50-unit run) | Target sub-$400 per apiary (hub + 5 nodes) |

---

## Appendix A: BroodMinder Comparison

| Capability | BroodMinder | BeeKeeper Hardware |
|------------|-------------|-------------------|
| Temperature | +/-1F, $35-280/sensor | +/-0.3C (SC833F), $20/sensor |
| Humidity | Yes (TH2 model) | Yes (SC833F) |
| Weight | +/-0.01 lb, $110+ | +/-50g, $52/hive (DIY) |
| Pressure | No | Yes (hub BME280) |
| Accelerometer/tilt | No | Yes (SC833F LIS3DH) |
| Per-frame thermal map | **No** | **Yes (S05T stickers)** |
| Entrance camera + ML | **No** | **Yes (IMX519 + 12 TOPS NPU)** |
| Bee counting | **No** | **Yes (on-device ML)** |
| Varroa detection | **No** | **Yes (on-device ML)** |
| Acoustic swarm detection | **No** | **Yes (Phase 1, INMP441 wired to Tachyon)** |
| On-device AI | **No** | **Yes (12 TOPS)** |
| Requires hub purchase | Yes ($100+) | Included (Tachyon is the hub) |
| Subscription required | Yes (MyBroodMinder) | **No** (self-hosted BeeKeeper app) |
| Total per hive | $200-400+ | $119-199 (Phase 1) |
| Open source | No | Yes |

---

## Appendix B: Bee Army Comparison

| Capability | Bee Army | BeeKeeper Hardware |
|------------|----------|-------------------|
| Temperature | +/-0.2F, multi-sensor | +/-0.3C (SC833F), $20/sensor |
| Humidity | Yes (multi-sensor) | Yes (SC833F) |
| Weight | Scale (specs unspecified) | +/-50g, HX711 + 4x load cells |
| Acoustic monitoring | **Yes — 10s clips, 0-1400 Hz** | **Yes — 10s clips, INMP441 (Phase 1)** |
| Swarm prediction | 5-10 days advance via sound | Via sound + vision + thermal ML |
| Queen loss detection | Yes (audio) | Yes (audio ML + thermal map) |
| Fall/displacement detection | Yes | Yes (SC833F LIS3DH accelerometer) |
| Per-frame thermal map | **No** | **Yes (S05T stickers)** |
| Entrance camera | PTZ 5MP, night vision, motion | IMX519 16MP + ML inference (bee counting, varroa) |
| On-device AI | **No** | **Yes (12 TOPS NPU)** |
| Bee counting | **No** | **Yes (computer vision ML)** |
| Varroa detection | **No** | **Yes (computer vision ML)** |
| Gateway battery | 7.2Ah 12V built-in | 7.2Ah 12V LiFePO4 (~8.5h autonomy) |
| Solar support | 5-15W panel input | 50W+ panel (Option B) |
| Connectivity | WiFi + BLE 5.0 | WiFi 6E + BLE 5.2 + 5G fallback |
| Sensor range from gateway | 80 ft max | 200m+ (BLE 5.2 coded PHY) |
| Subscription required | Yes (annual PRO) | **No** (self-hosted) |
| Per-hive cost | $84-147/hive (kit) + subscription | $119-199/hive (no subscription) |
| Open source | No | Yes |
