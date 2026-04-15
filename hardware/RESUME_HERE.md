# Resume Here — BeeKeeper Hardware Build

> Last updated: 2026-04-15 (end of MacBook session, before Mac Mini handoff)

This is the entry point if you're picking up the BeeKeeper hardware build mid-stream. Read this first, then dive into the spec docs.

## Mental Model

We're building a hardware add-on for the existing [BeeKeeper web app](../) that monitors hive sensors, runs vision/audio AI on-device, and feeds a prediction layer that beats BroodMinder and Bee Army on accuracy + explainability + LLM-driven advice.

**Three documents** define the build:
1. [`HARDWARE_SPEC.md`](./HARDWARE_SPEC.md) — Tachyon hub, BLE sensors, cameras, mics, weight, power, BOM, mounting
2. [`INTELLIGENCE_SPEC.md`](./INTELLIGENCE_SPEC.md) — Predictive models, multi-modal fusion, LLM Advisor, training pipeline, cost model
3. This file — Where we are and what's next

## Status Snapshot

| Component | Status |
|---|---|
| Specs (HARDWARE + INTELLIGENCE) | ✅ Complete, in git |
| Tachyon (Particle, IP `192.168.1.146`) | ✅ Ubuntu 24.04, BLE working, qai-hub installed |
| Tachyon NPU compile pipeline | ✅ Validated (target: Dragonwing RB3 / QCS6490) |
| BeeKeeper API extensions | ✅ Migration 11 + `routes/hubs.ts` + Hub/SensorReadingRaw Prisma models |
| Tachyon hub firmware | ✅ Scaffolding at `tachyon-hub/` (BLE parsers are RSSI placeholders pending hardware) |
| Mac Mini training environment | ✅ Python 3.12 venv with ultralytics + roboflow, MPS available |
| Migration 11 + hubs router DEPLOYED to Railway | ❌ NOT YET — local only |
| Bee detection model | ⏳ Need to train YOLOv8n locally on Mac Mini (Roboflow free tier blocks weights export) |
| QNN runtime .so libraries on Tachyon | ⏳ Pending |
| Physical sensors | ⏳ On order — SC833F, S05T, ESP32-C6, HX711, load cells, IMX519, INMP441, BME280, batteries |

## Connection Cheatsheet

| Where | How |
|---|---|
| Mac Mini Claude Code (from MacBook) | `mini` alias → SSH+tmux to thomdigitalai@192.168.1.250 |
| Mac Mini visual desktop | Finder ⌘K → `vnc://192.168.1.250` |
| Tachyon SSH | `ssh particle@192.168.1.146` (also reachable from Mac Mini) |
| Tachyon AI venv | `source ~/beekeeper-ai/bin/activate` |
| Mac Mini training venv | `source ~/Claud/beekeeping/training/venv/bin/activate` |
| BeeKeeper API (production) | https://beekeeper-api-production.up.railway.app |

## Next Concrete Actions (in order)

### A. Train the bee detection model
```bash
# On Mac Mini
cd ~/Claud/beekeeping/training
source venv/bin/activate

# Get dataset from Roboflow (use the Python snippet from the project's "Download Dataset" page)
# After dataset is downloaded:
yolo train model=yolov8n.pt data=data.yaml epochs=100 imgsz=640 batch=16 device=mps
yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=640 opset=13
```

### B. Deploy bee model to Tachyon
```bash
# From Mac Mini
scp runs/detect/train/weights/best.onnx particle@192.168.1.146:~/qnn-test/bees.onnx

# On Tachyon
source ~/beekeeper-ai/bin/activate
python3 -c "
import qai_hub as hub
device = hub.Device('Dragonwing RB3 Gen 2 Vision Kit')
job = hub.submit_compile_job(model='/home/particle/qnn-test/bees.onnx', device=device, options='--target_runtime qnn_context_binary')
print(job.url)
"
# Wait for compile, download .bin, validate inference job
```

### C. Deploy API changes to Railway
```bash
# On Mac Mini, from ~/Claud/beekeeping
git push        # confirm changes are on origin/main
railway up      # or trigger deploy via Railway dashboard

# Verify migration 11 ran:
# Visit https://beekeeper-api-production.up.railway.app/health
```

### D. When physical sensors arrive
1. **SC833F (BLE primary sensor)** — sniff its advertisement payload with `bluetoothctl` + `btmon` on the Tachyon, decode the manufacturer-specific data bytes, finalize parser in `tachyon-hub/src/ble-scanner.js` (currently RSSI-only placeholder)
2. **S05T (thermal map sticker)** — same byte-layout discovery process
3. **ESP32-C6 Pocket** — flash with custom firmware that reads BME280 over Qwiic and broadcasts BLE advertisements with sensor data
4. **HX711 + load cells** — wire to Tachyon GPIO 5/6 (Hive 1) and 13/19 (Hive 2), calibrate with known weights
5. **INMP441 mics** — configure I2S on Tachyon, capture 10s clips hourly
6. **IMX519 cameras** — connect to Tachyon CSI ports, validate capture, run bee detection model

### E. Once data flows: build the intelligence layer
See `INTELLIGENCE_SPEC.md` Phase 1 — start with rule-based predictors and the Colony Health Score, layer on ML as data accumulates.

## Critical Files

| File | Why it matters |
|---|---|
| `hardware/HARDWARE_SPEC.md` | Source of truth for sensor stack, BOM, wiring |
| `hardware/INTELLIGENCE_SPEC.md` | Source of truth for predictions, LLM, training pipeline |
| `hardware/tachyon-hub/` | Hub firmware code, ready to deploy to Tachyon |
| `packages/db/prisma/migrations/11_add_tachyon_hub_and_raw_readings/` | Adds `hubs` + `sensor_readings_raw` tables (additive only) |
| `apps/api/src/routes/hubs.ts` | API endpoints for hub registration, ingestion, heartbeat, config |
| `CLAUDE.md` | **Read first** for data safety rules — migrations must be additive, no destructive operations |

## Trigger Words for Memory

In a fresh Claude Code session, type:
- **`hardware`** to load the hardware spec context
- **`intelligence`** to load the prediction layer context
- **`beekeeping`** to load full project context

## Open Questions / Decisions Pending

1. **API deploy timing** — when to push migration 11 to Railway (production has bees arriving April 18; coordinate so prod is stable)
2. **ESP32-C6 vs custom nRF52840** — Phase 1 spec says SC833F + ESP32-C6 + wired HX711. Phase 2 was custom nRF52840 nodes. ESP32-C6 may let us skip Phase 2 entirely
3. **MOKOSmart S05T sourcing** — OEM/ODM, likely 100+ unit MOQ. Need to email MOKOSmart
4. **Audio storage retention** — current spec says 24h hot for raw WAV, 7d warm for spectrograms. Confirm against R2 cost projections
5. **Federated baseline opt-in vs opt-out** — needs legal/product call before launch
