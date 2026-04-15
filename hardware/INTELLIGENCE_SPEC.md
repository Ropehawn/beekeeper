# BeeKeeper Intelligence Specification

| Field | Value |
|-------|-------|
| Project | BeeKeeper Hardware — Prediction Layer |
| Author | ThomDigital Group LTD |
| Date | 2026-04-14 |
| Status | Draft — Phase 1 |
| Revision | 1.0 |
| Companion | HARDWARE_SPEC.md (Rev 1.2) |

---

## 1. Thesis

Hardware is a commodity race to the bottom. BroodMinder and Bee Army compete on sensor count and price. **We compete on prediction accuracy, explainability, and the language interface to the hive.** Every sensor in the BeeKeeper stack exists to feed the prediction layer. A customer pays $800 upfront and $29/month not for temperature graphs — they pay because, at 3 PM on a Tuesday in April, our system sends: *"Hive 2 will swarm in 9±2 days. Primary evidence: brood-nest heat signature at 36.1°C (swarm-typical), 2.1 kg/day weight gain plateau starting yesterday, low-frequency piping detected in last audio clip, no new eggs visible in entrance pollen-loader footage. Recommended action: split within 72 hours or add super + checker-board."*

No competitor can generate that paragraph. The rest of this document is how we build it.

---

## 2. Three-Tier Compute Architecture

### 2.1 Compute inventory (post-DGX-return)

| Tier | Hardware | Capability | Cost profile | Latency |
|------|----------|------------|--------------|---------|
| **Edge** | Particle Tachyon per apiary | 12 TOPS Hexagon NPU, 8 GB RAM | Already owned | < 100 ms |
| **API** | Railway (Express + Prisma) | CPU only, ~4 vCPU/8 GB | ~$40/mo baseline | < 500 ms |
| **LLM** | Claude API (Sonnet 4.5 primary, Opus 4.6 for deep analysis) | Hosted | ~$0.003–$0.015 per user-query | 1–3 s |
| **Cloud ML** | Modal (training + scheduled batch), Together / Replicate (inference fallback) | A100/H100 pay-per-second | $0.50–$3/hr when used | Batch only |
| **Always-on Mac mini** | Apple M-series ANE, 16 GB | Local dev, nightly Core ML compiles, staging inference | Already owned | N/A (internal) |

### 2.2 What runs where — the placement rule

Each model is placed by answering three questions in order:

1. **Does it need raw signal that is too expensive to upload?** (audio, video, >1 Hz accel) → **Edge**.
2. **Does it need cross-hive or historical context, or per-customer personalization?** → **API**.
3. **Does it need a GPU, and is batch latency acceptable?** → **Cloud ML**.

Anything that needs natural language reasoning calls the **LLM tier** on demand.

### 2.3 Tier responsibilities

**Edge (Tachyon):**
- Raw audio -> FFT features (mel-spectrogram, 128 bins) every hour. Ship features, not WAV.
- Vision: bee entrance counting + varroa phoretic-mite detection on CSI cameras. Ship counts + bounding boxes, not 1080p video.
- Thermal sticker deltas — pre-filter noise, ship only changes > 0.4°C.
- Accelerometer: on-device FFT, ship amplitude + dominant frequency band.
- On-device anomaly gate — if nothing interesting happened in the last hour, ship only a heartbeat.
- Models: quantized INT8 (CNNs) or ONNX/TFLite for sequential models. Delivered OTA via Particle fleet.

**API (Railway):**
- Multi-modal fusion (lightweight transformer or gradient-boosted trees) computing `HealthScore`.
- Rule-based predictors (Phase 1) for swarm, queen status, winter survival.
- Time-series forecasters (Prophet/ARIMA-equivalent in Python sidecar, or statsmodels in a scheduled Modal job — see §9).
- Prompt assembly + Claude API invocation for the LLM Advisor.
- Aggregation endpoints for cross-apiary federated features.

**Cloud ML (Modal):**
- Nightly retraining of fusion model using new `ExpertFeedback`.
- Quarterly retraining of vision (YOLO variant) and audio (1D CNN) backbones.
- Synthetic data generation (GAN for hive audio augmentation, rare-case upsampling).
- Batch scoring jobs — e.g. "recompute winter survival probability for every hive weekly".
- Outputs: new quantized weights pushed to Particle OTA bucket.

**LLM (Claude API):**
- Natural language Q&A against a hive's sensor context.
- Weekly digest generation per hive / per apiary.
- Inspection-note parsing → structured `ExpertFeedback` rows.
- Explanation generation for every `Prediction` (see §8).

---

## 3. Predictive Models Catalog

Each model below lists inputs, algorithm, placement tier, output, competitive delta, and failure mode.

### 3.1 Swarm Prediction (target: 7–14 days horizon)

| | |
|---|---|
| **Inputs** | 7-day weight trend, 24 h weight derivative, brood-nest temp (S05T stickers), entrance bee-count trend, audio low-freq band (100–500 Hz for piping/queen tooting), accel (pre-swarm cluster vibration), inspection log (cells present). |
| **Algorithm** | Phase 1: hand-coded rule ensemble with weighted evidence. Phase 2: gradient-boosted tree (LightGBM) trained on labeled `SwarmEvent` rows. Phase 3: small Transformer over 7-day sensor window (~500 k params). |
| **Tier** | Features computed at edge (audio, vision). Scoring on API. Retraining on Modal. |
| **Output** | `{ probability: 0.0–1.0, daysUntil: int, confidence: 0.0–1.0, evidence: Evidence[] }`. |
| **Edge over Bee Army** | Multi-modal: they use audio only. We fuse thermal + vision + weight, so false-positive rate should fall ~3× based on published audio-only baselines. |
| **Failure mode** | Over-calling in strong nectar flow (weight gain mimics pre-swarm build-up). Mitigated by piping audio + absence-of-queen-cell-signal fallback. |

### 3.2 Queen Status (present / absent / virgin / mated / failing)

| | |
|---|---|
| **Inputs** | Audio (roar vs. hum, "queenless roar" spectral signature at ~225 Hz peak), brood pattern from frame photos (uploaded in-app by user), hive temp stability (queenless hives thermoregulate poorly), weight plateau, entrance traffic balance (pollen-in vs out). |
| **Algorithm** | 1D CNN on mel-spectrogram + tabular MLP head fusing non-audio features. Trained on labeled audio clips + inspection-confirmed queen status. |
| **Tier** | 1D CNN runs on edge (INT8, ~2 MB model). Fusion on API. |
| **Output** | `{ status: 'queenright' \| 'queenless' \| 'virgin' \| 'failing' \| 'unknown', confidence, daysInState }`. |
| **Edge over Bee Army** | They claim queen-loss detection via audio. We add brood-pattern vision + thermoregulation signal — catches failing queens weeks before sound changes. |
| **Failure mode** | Virgin vs. mated confusion in first 14 days post-emergence. We down-weight confidence during this window rather than guess. |

### 3.3 Varroa Mite Load (mites per 100 bees, estimated)

| | |
|---|---|
| **Inputs** | Entrance CSI camera video bursts, frame photo uploads. Optional: sticky-board photo upload. |
| **Algorithm** | YOLOv8-nano fine-tuned on ~3 000 bee images labeled for phoretic varroa (we start with BeeCV / BeeMachine public datasets + our own labeling). Per-bee classifier `mite_present`. Aggregate to `mites_per_100_bees`. |
| **Tier** | YOLO at edge (quantized to ~6 MB, runs at ~8 FPS on Hexagon NPU — enough for 10-second bursts). Aggregation + smoothing on API. |
| **Output** | `{ mitesPer100: float, trend7d: float, method: 'video'\|'sticky'\|'fused', confidence }`. |
| **Edge over competitors** | **Nobody else has this.** BroodMinder has no vision. Bee Army has no vision. This is our most defensible single feature. |
| **Failure mode** | Night / low-light. Camera bursts are daylight-only. Sticky-board photos are the fallback and can be user-prompted. |

### 3.4 Harvest Timing Optimization

| | |
|---|---|
| **Inputs** | Weight gain curve, nectar-flow inflection, moisture proxy (humidity inside super), frame fullness from user photos, local weather forecast (NOAA / Open-Meteo). |
| **Algorithm** | LSTM (4 layers, 64 hidden) forecasting weight-gain trajectory 14 days out. Peak detection on forecast. Cross-checked against forecasted weather (predicted rain → harvest earlier). |
| **Tier** | Training on Modal. Inference on API (LSTM is cheap on CPU). |
| **Output** | `{ recommendedDate: Date, estimatedYieldLbs: float, confidenceInterval: [low, high], reasoning: string[] }`. |
| **Edge over competitors** | BroodMinder shows weight charts. We recommend a date, with uncertainty, tied to weather. |
| **Failure mode** | Unexpected dearth (flowers die early). Retrained weekly so drift stays small. |

### 3.5 Winter Survival Probability

| | |
|---|---|
| **Inputs** | Fall weight, fall mite load (§3.3), late-season brood pattern, cluster-position thermal map (S05T), average hive temp trend, local winter severity forecast, colony-genetics flag (Italian/Carniolan/etc. from `Hive.strain`). |
| **Algorithm** | Logistic regression (interpretable baseline) + gradient-boosted tree (accuracy) with probability calibration (Platt / isotonic). |
| **Tier** | Training on Modal (quarterly). Inference on API. |
| **Output** | `{ survivalProbability: 0.0–1.0, primaryRiskFactor: 'stores'\|'mites'\|'queenFailure'\|'weather', mitigations: Action[] }`. |
| **Edge** | Ties directly to actions. Competitors produce data; we produce decisions. |
| **Failure mode** | First-year cold start — we publish the model with hand-tuned priors from peer-reviewed survival studies, then refine with customer data. |

### 3.6 Disease / Pest Onset Detection

| | |
|---|---|
| **Inputs** | Frame photos (American/European foulbrood, chalkbrood, sacbrood visual signatures), entrance footage (crawling bees, K-wing — tracheal mite proxy), audio anomaly score, abnormal weight-loss rate. |
| **Algorithm** | Vision: multi-label CNN (EfficientNet-B0 fine-tuned) classifying disease from frame photos. Audio: anomaly detection via autoencoder reconstruction error. |
| **Tier** | Frame photo classification on API (photos uploaded, not streamed). Audio anomaly on edge. |
| **Output** | `{ disease?: DiseaseLabel, confidence, recommendedInspectionWithinDays }`. |
| **Edge** | Neither competitor attempts disease detection. This is a Q4-Phase-2 feature gated on labeled dataset size. |
| **Failure mode** | High false-positive risk on ambiguous photos. Ships as "inspect within N days" not "you have AFB" until precision > 90%. |

### 3.7 Queen Quality Score

| | |
|---|---|
| **Inputs** | Brood-pattern regularity (vision — spotty vs. solid), lay rate (calculated from weight growth + frame-photo brood-area over time), temperament flag (from user log), supersedure-cell history. |
| **Algorithm** | Composite score `0–100` computed from weighted components. Phase 2 upgrade: learned weights via regression against user-reported "would you re-queen?". |
| **Tier** | API. |
| **Output** | `{ score: int, components: { layRate, broodPattern, temperament, genetics } }`. |
| **Edge** | Unique. Queen-quality is the single biggest lever on hive productivity and no product scores it. |
| **Failure mode** | Spotty brood is sometimes genetic (inbreeding), sometimes disease. We pair this with §3.6. |

### 3.8 Requeen Timing Recommendation

| | |
|---|---|
| **Inputs** | §3.7 Queen Quality Score trend, §3.2 Queen Status, seasonal window (don't requeen in Oct if you can't overwinter a dink), queen-vendor lead time (user-configurable). |
| **Algorithm** | Rule-based with seasonal windowing + user-preference learning (does this beekeeper tend to requeen aggressively or conservatively?). |
| **Tier** | API. |
| **Output** | `{ shouldRequeen: bool, idealWindow: DateRange, reasoning }`. |
| **Edge** | Actionable recommendation, not raw data. |
| **Failure mode** | Recommending requeen before a known flow → user loses honey. Mitigated by integrating §3.4. |

---

## 4. Multi-Modal Fusion — the Colony Health Score

### 4.1 Why fusion is the moat

Every single-signal model above can be wrong. A colony with low mite load but a failing queen is in trouble. A colony with a strong queen but no stores is in trouble. The **Colony Health Score** (CHS) is a single `0–100` number with a breakdown, refreshed hourly, that no single-sensor competitor can produce.

### 4.2 Architecture

```
   Edge features ──┐
   (audio, vision) │
                   │
   BLE sensors ────┤
   (temp, hum, acc)│──► Feature Normalizer ──► Fusion Model ──► CHS + breakdown
                   │       (API)                (API)              │
   Weight series ──┤                                                │
                   │                                                ▼
   Frame photos ───┤                                     Prediction table
   Inspection log ─┘                                     + Explanation via Claude
```

### 4.3 Model choice — progressive complexity

- **Phase 1 (launch)**: Weighted average with hand-picked weights informed by beekeeping literature. Publishable, explainable, no training data needed.
- **Phase 2 (60 days data)**: Gradient-boosted regressor on `(features) → expert-labeled health_score`. LightGBM. SHAP values for explainability.
- **Phase 3 (6 months data, 10+ apiaries)**: Small Transformer encoder (~2 M params) over a 7-day window of multi-modal features. Attention weights used for explanation.

### 4.4 CHS decomposition (exposed to user)

```
CHS 78/100
  ├─ Population dynamics      84  ← bee counts steady, traffic healthy
  ├─ Queen & brood            72  ← lay rate below seasonal norm
  ├─ Food stores              88  ← 62 lb, on track for winter
  ├─ Disease & pest load      65  ← mite count rising (2.3/100 last week)
  ├─ Behavioral stability     80  ← audio/accel within normal range
  └─ Environmental fit        79  ← hive temp variance 0.4°C above ideal
```

This is the screen users stare at. It's the product.

---

## 5. LLM Beekeeping Advisor — "Ask Your Apiary Anything"

### 5.1 Product surface

Three entry points, all powered by Claude API:

1. **Chat tab** per apiary — free-form questions. "Why is Hive 2 losing weight?"
2. **Weekly Digest email** — auto-generated Sunday 6 AM local, one email per apiary.
3. **Alert explanations** — every push notification includes an LLM-generated "why this matters" paragraph.

### 5.2 Prompt architecture

All LLM calls use the same three-layer prompt pattern, assembled server-side in `apps/api/src/llm/advisor.ts`:

```
[SYSTEM]  BeeKeeper Advisor system prompt (persona + guardrails + tool definitions)
[CONTEXT] Structured JSON snapshot of the relevant hive(s):
          - Identity (name, strain, age, location, climate zone)
          - Last 7 days aggregate sensor stats
          - Active predictions + evidence
          - Recent inspection notes (user-entered)
          - Recent alerts
[USER]    The beekeeper's question (or "generate weekly digest" for cron path)
```

### 5.3 Tools exposed to Claude

To keep context small, the advisor uses tool-use to pull more data on demand:

- `get_sensor_window(hiveId, metric, start, end)` → returns downsampled time series
- `get_inspection_log(hiveId, limit)` → user's notes
- `get_prediction(hiveId, type)` → full `Prediction` row + evidence
- `get_weather_forecast(apiaryId, days)` → NOAA / Open-Meteo passthrough
- `get_similar_hives(hiveId)` → anonymized peers with matching features (federated, Phase 3)

### 5.4 Example interaction

> User: *"Hive 2 lost 4 lb this week. Should I worry?"*

1. Advisor calls `get_sensor_window(hive2, weight, -7d, now)` — confirms loss.
2. Calls `get_weather_forecast(apiary1, -7d)` — 5 days of rain.
3. Calls `get_prediction(hive2, 'swarm')` — probability 0.08, no.
4. Calls `get_inspection_log(hive2, 3)` — last inspection 12 days ago noted queen present.

Response:
> "Not alarming. Rain 5 of last 7 days kept foragers home, so some loss is expected from consumption alone (~2 lb typical). The other 2 lb matches a normal late-April brood-cycle consumption. Your swarm risk is low (8%), queen was present last inspection, and mite load is stable. I'd check again after the clear spell forecast Thursday–Sunday — if weight gain doesn't resume at +0.5 lb/day by Saturday evening, open it up."

### 5.5 Weekly digest template

One digest per apiary, sent Sunday 6 AM local:

```
Subject: Your apiary — week of Apr 6 (2 hives, 1 needs attention)

ONE-LINER ──
Hive 1 is cruising. Hive 2 needs a mite check in the next 10 days.

HIGHLIGHTS ──
• Net weight change: +7.2 lb across apiary
• Colony Health Scores: Hive 1 → 88 (↑3), Hive 2 → 72 (↓6)
• 0 swarm-risk alerts, 1 mite-load alert (Hive 2)

ACTIONS THIS WEEK ──
1. Hive 2: sugar-roll mite test before Apr 19. Current estimate 2.3/100 (threshold 3.0).
2. Both hives: consider adding a super by Apr 22 — forecast shows continued nectar flow.

DETAIL PER HIVE ──
[auto-generated per-hive paragraphs with key charts inlined]
```

### 5.6 Cost per user — see §10

---

## 6. Data Schema Extensions (Prisma)

All new tables are **additive** per the data safety rules in `beekeeping/CLAUDE.md`. Migrations live under `packages/db/prisma/migrations/`.

### 6.1 Raw signal tables (training data backbone)

```prisma
model SensorReadingRaw {
  id         String   @id @default(cuid())
  hiveId     String
  sensorId   String   // FK to Sensor (BLE MAC, HX711, mic, etc.)
  metric     String   // 'temp'|'humidity'|'weight'|'accel_x'|'accel_y'|'accel_z'|'ambient_temp'|...
  value      Float
  unit       String   // 'C'|'%rh'|'g'|'m/s2'|...
  recordedAt DateTime
  quality    Float?   // 0–1 sensor-health confidence
  hive       Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, metric, recordedAt])
  @@index([recordedAt])
}

model AudioClip {
  id            String   @id @default(cuid())
  hiveId        String
  recordedAt    DateTime
  durationMs    Int
  r2Key         String   // raw WAV in R2, 24h retention for cost
  spectrogramR2Key String? // persistent mel-spectrogram PNG / NPY
  featuresJson  Json?    // dominant freq, RMS, band energies, anomaly score
  classLabel    String?  // expert-labeled, nullable
  labeledBy     String?  // User.id
  hive          Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, recordedAt])
}

model VisionDetection {
  id            String   @id @default(cuid())
  hiveId        String
  cameraId      String
  recordedAt    DateTime
  frameR2Key    String?
  detections    Json     // array of { class, bbox, confidence, trackId }
  beeCount      Int?
  varroaCount   Int?     // detected phoretic mites
  pollenLoaders Int?
  hive          Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, recordedAt])
}

model ThermalSnapshot {
  id            String   @id @default(cuid())
  hiveId        String
  recordedAt    DateTime
  perStickerC   Json     // { "S05T-A1": 34.2, "S05T-A2": 35.1, ... }
  gridLayout    Json     // frame positions of stickers
  clusterCentroid Json?  // { frame: 4, x: 0.5, y: 0.3 } — derived
  hive          Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, recordedAt])
}
```

### 6.2 Derived-state tables

```prisma
model HealthScore {
  id              String   @id @default(cuid())
  hiveId          String
  computedAt      DateTime @default(now())
  score           Int      // 0–100
  components      Json     // { population, queenBrood, stores, disease, behavior, env }
  modelVersion    String
  hive            Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, computedAt])
}

model Prediction {
  id              String   @id @default(cuid())
  hiveId          String
  predictionType  String   // 'swarm'|'queenStatus'|'varroaLoad'|'harvestTiming'|'winterSurvival'|'disease'|'queenQuality'|'requeen'
  value           Json     // model-specific payload
  confidence      Float
  horizonDays     Int?
  evidence        Json     // Evidence[] — see §8
  modelVersion    String
  computedAt      DateTime @default(now())
  validUntil      DateTime?
  realized        Boolean? // set when ground truth arrives
  realizedAt      DateTime?
  realizedValue   Json?
  hive            Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, predictionType, computedAt])
}

model ExpertFeedback {
  id              String   @id @default(cuid())
  hiveId          String
  userId          String
  feedbackType    String   // 'swarmOccurred'|'queenConfirmed'|'mitesCountedManual'|'healthLabel'|'predictionCorrect'|'predictionWrong'
  feedbackValue   Json
  relatedPredictionId String?
  notes           String?
  recordedAt      DateTime @default(now())
  hive            Hive     @relation(fields: [hiveId], references: [id])
  @@index([hiveId, feedbackType])
}

model ModelVersion {
  id              String   @id @default(cuid())
  name            String   // 'swarm_lgbm' | 'queen_audio_cnn' | 'varroa_yolo' | 'fusion_v3'
  version         String   // semver-like
  tier            String   // 'edge'|'api'|'cloud'
  artifactR2Key   String
  trainingDataCutoff DateTime
  metricsJson     Json     // precision, recall, f1, calibration
  deployedAt      DateTime?
  @@unique([name, version])
}

model InferenceLog {
  id              String   @id @default(cuid())
  modelVersionId  String
  hiveId          String?
  inputHash       String
  outputJson      Json
  latencyMs       Int
  costUsdMicros   Int?     // for LLM and Modal calls
  createdAt       DateTime @default(now())
  @@index([modelVersionId, createdAt])
}
```

### 6.3 Retention policy

- `SensorReadingRaw` — 400 days hot, then downsampled to hourly in an archive table.
- `AudioClip.r2Key` (raw WAV) — 24 hours. Spectrogram persists 400 days.
- `VisionDetection.frameR2Key` — 7 days (unless flagged for training, moved to `TrainingAsset`).
- `ThermalSnapshot` — hourly, retained 2 years.
- `HealthScore`, `Prediction`, `ExpertFeedback` — retained indefinitely.

---

## 7. Training Data Strategy

### 7.1 The cold-start problem

Two hives in Michael's backyard will not train a varroa YOLO from scratch. We attack this on four fronts:

1. **Public datasets we bootstrap from**
   - BeeCV + BeeAlert labeled bee images (~20 k bees, ~2 k with phoretic mites)
   - Apis-Sound open audio corpus (~400 hours of hive audio, subset labeled queenless)
   - Beekeeping weight datasets from OSBeehives/HiveTool open data where license permits
2. **Michael's apiary as Day-0 ground truth** — every inspection becomes an `ExpertFeedback` row. Every frame photo becomes a potential `TrainingAsset`. Target: 50 labeled inspections over 6 months.
3. **Expert-in-the-loop labeling** — we pay two experienced beekeepers (locally, 1099) $40/hour to label 10 hours/week of queued audio + vision once we hit 5 customers. Budget $1 200/month, scales down to zero when dataset is large enough.
4. **Synthetic data** — for rare failures (AFB, CCD crash) we generate synthetic audio via mel-spectrogram GAN trained on healthy audio + published pathology descriptions, and synthetic vision via mixup / domain randomization.

### 7.2 Active learning loop

```
Model predicts → low-confidence prediction → surface to user in app
             → user confirms or corrects → ExpertFeedback row
             → nightly Modal job appends to TrainingAsset
             → weekly Modal job retrains + evaluates against holdout
             → if new metrics ≥ prod + 1%, stage for OTA
             → human-in-the-loop approval → deploy
```

### 7.3 Labeling UI (built into app)

When the user opens a hive, if there's a pending low-confidence prediction, show a 10-second card: *"We think this is a queenless roar — is your queen present?"* Button tap becomes an `ExpertFeedback` row. This is a key differentiator: every customer makes every model smarter.

---

## 8. Explainable Predictions

### 8.1 The rule

**Every `Prediction` row must carry a non-empty `evidence` array.** The UI never shows a score without its receipts.

### 8.2 Evidence schema

```ts
type Evidence = {
  signal: string;           // 'weight_derivative_24h' | 'audio_band_100_500hz' | ...
  observation: string;      // '+2.1 kg/day for 3 consecutive days'
  contribution: number;     // positive if this evidence pushes probability up
  sourceRef?: {             // clickable back to raw data
    kind: 'sensor' | 'audio' | 'vision' | 'thermal' | 'inspection';
    id: string;
    recordedAt: string;
  };
  literatureRef?: string;   // DOI or citation for the causal mechanism
};
```

### 8.3 How explanations are generated

- **Rule-based models**: evidence emitted directly by the rule that fired.
- **Tree models (LightGBM)**: SHAP values per feature → top-5 become Evidence entries.
- **Neural models**: attention weights (Transformer) or integrated gradients (CNN) → feature attributions.
- **LLM polish**: the raw Evidence array is passed to Claude with a prompt to render it into a plain-English paragraph. Tech stays in the JSON; prose shows in the UI.

### 8.4 User-facing surface

```
⚠ Swarm predicted in 9 ± 2 days — 78% confidence

Why we think so:
  ✔ Weight gain plateaued yesterday after 12 days of +2.1 kg/day  →  +0.22
  ✔ Brood-nest temp 36.1°C (swarm-typical, normal 34.5°C)         →  +0.18
  ✔ Low-frequency piping detected in last audio clip (230 Hz)     →  +0.15
  ✔ Entrance bee count doubled Tue–Thu (scout activity)           →  +0.14
  ✘ No queen cells seen in last frame photo (3 days ago)          →  −0.04

Tap any ✔ to see the raw data.
```

This single screen is the pitch deck.

---

## 9. Model Training Pipeline

### 9.1 Stack

- **Orchestration**: Modal functions scheduled via `@modal.periodic` + GitHub Actions for release gating.
- **Experiment tracking**: Weights & Biases (free tier is enough at our scale).
- **Artifact storage**: R2 (we already use it).
- **Registry**: `ModelVersion` table in Postgres.

### 9.2 Training cadence

| Model | Retrain | Compute | Budget |
|-------|---------|---------|--------|
| Fusion / CHS (LightGBM) | Nightly if >50 new `ExpertFeedback` rows | Modal CPU 2 min | ~$0.02/run |
| Swarm LightGBM | Weekly | Modal CPU 10 min | ~$0.10/run |
| Queen-audio CNN | Monthly | Modal A10G 1 hr | ~$1.50/run |
| Varroa YOLO | Quarterly + when dataset grows 20% | Modal A100 3 hr | ~$8/run |
| Winter-survival GBT | Monthly Sep–Feb, else quarterly | Modal CPU 5 min | ~$0.05/run |

Total training spend target: **< $50/month** until we hit 100 customers.

### 9.3 Deployment flow

1. Modal trains → writes new `ModelVersion` row with `deployedAt=null`.
2. Eval script computes metrics vs. prod on held-out `ExpertFeedback`.
3. If improvement passes gate, GitHub Actions publishes:
   - API-tier models: packaged in `apps/api` on next Railway deploy.
   - Edge-tier models: uploaded to Particle OTA bucket, fleet assigned new firmware group containing the quantized artifact. Tachyons download on next check-in.
4. `deployedAt` is stamped. `InferenceLog` starts recording against new version.

### 9.4 Rollback

Particle OTA supports atomic group rollback. API-tier models ship with a feature flag (`MODEL_VERSION_FUSION`) that points at a specific `ModelVersion.id`; flipping the env var rolls back in < 30 seconds.

### 9.5 Shadow deployment

New models run in shadow for 7 days: predictions are logged to `InferenceLog` but never shown to users. Only after 7 days of shadow-vs-prod comparison do we promote.

---

## 10. Cost Model

### 10.1 Per-user monthly cost (target: 2-hive apiary, Phase 2)

| Line | Unit cost | Volume | Monthly |
|------|-----------|--------|---------|
| Railway API share | — | — | $2.00 |
| Postgres storage/compute | — | — | $0.50 |
| R2 storage (sensor + downsampled audio/vision) | $0.015/GB | ~5 GB steady-state | $0.08 |
| R2 egress (OTA + app) | $0 (Cloudflare) | — | $0 |
| Modal training amortized | — | shared across users | $0.20 |
| Modal batch scoring (weekly survival, etc.) | — | — | $0.15 |
| Claude API — weekly digest | ~6 000 in + 1 500 out tokens @ Sonnet 4.5 | 4 digests/mo | $0.12 |
| Claude API — alert explanations | ~1 500 in + 400 out | ~15/mo | $0.15 |
| Claude API — user chat | ~4 000 in + 800 out | ~20 turns/mo | $0.60 |
| Claude API — inspection-note parsing | ~2 000 in + 300 out | ~4/mo | $0.05 |
| **Total variable** | | | **~$3.85** |

Against a $29/month subscription, gross margin ~87%. Healthy. Opus usage is reserved for quarterly deep analyses (not in this table) and user-opt-in "deep dive" requests.

### 10.2 Prompt caching to protect margin

All LLM calls use Claude's prompt-caching. The apiary-specific CONTEXT block is cached with a 1-hour TTL — the first call pays full price, subsequent calls within the hour pay 10%. On chat-heavy users, this cuts Claude spend ~60%.

### 10.3 Cost ceiling alerts

Per-user Claude cost is logged in `InferenceLog.costUsdMicros`. If a user crosses $2/month in Claude alone, we page. Likely cause is a runaway loop or a user hammering chat — rate-limit chat to 50 turns/day hard.

---

## 11. Cross-Apiary Federated Intelligence (Phase 3 moat)

### 11.1 Why this wins

Once we have 10+ apiaries spread geographically, each new customer benefits from the full network on Day 1. A new hive in Santa Rosa inherits the mite-load priors of nearby Sonoma County hives. A swarm spike across 4 apiaries in the Central Valley is an early warning to every other Central Valley customer. **BroodMinder has this data but does nothing with it. Bee Army's audio-only signals don't fuse usefully across hives.**

### 11.2 Architecture

- **Aggregation service** on Railway: nightly job computes regional percentiles (weight gain, mite load, swarm rate, CHS) bucketed by climate zone + 50 km grid + season.
- **No raw data leaves the tenant boundary.** We aggregate to `RegionalBaseline` rows: `{ region, metric, p10, p50, p90, n, computedAt }`.
- **Personalization** happens at inference time: models receive `(hive_features, regional_baseline)` as input. A hive flagged as anomalous is anomalous **against its peers**, not a global mean.
- **Federated averaging** for later model upgrades — once we have significant per-apiary diversity, we train regional sub-models via FedAvg on Modal without ever centralizing raw data. This is the architectural bet that makes us a data network, not a SaaS.

### 11.3 What users see

> "Your hive is in the 82nd percentile for weight gain compared with 14 similar hives in your region this week."

That sentence costs BroodMinder an engineering quarter to build. It costs us one `RegionalBaseline` table and one join.

---

## 12. Roadmap

### Phase 1 — "Smart Rules" (launch, now through 30 days of data)
- Ship rule-based swarm, queen-status, and harvest-timing predictors.
- Ship Colony Health Score with hand-tuned weights.
- Ship LLM Advisor (chat + weekly digest + alert explanations).
- Ship all Prisma tables from §6 — we start capturing training data immediately.
- Edge: deploy entrance bee-count vision (pretrained YOLO fine-tuned on public data).
- **Success metric**: Michael's 2 hives produce a weekly digest he would pay for.

### Phase 2 — "First ML" (30–180 days, 3–10 customers)
- Train first LightGBM swarm model on combined labeled data.
- Deploy queen-audio 1D CNN (public dataset + our labels).
- Deploy varroa YOLO (public + our labels).
- Train LSTM for harvest timing.
- Active-learning labeling UI in app.
- Federated-baseline aggregation service scaffold.
- **Success metric**: ML models outperform Phase 1 rules on precision@90%-recall by ≥ 10 pp.

### Phase 3 — "Network effects" (180+ days, 10+ customers)
- Regional baselines live in product.
- FedAvg model updates per climate zone.
- Disease/pest vision model gated on labeled dataset ≥ 500 positive cases.
- Queen Quality + Requeen Timing go from rule-based to learned.
- **Success metric**: CHS accuracy correlates with 30-day outcome at r ≥ 0.7.

### Phase 4 — "Platform" (12+ months)
- Open Advisor API to third parties (extension services, research).
- White-label for beekeeping clubs.
- Genetics integration (queen-breeder partnerships).

---

## 13. Why We Win (one-page summary)

| Capability | BroodMinder | Bee Army | BeeKeeper |
|------------|:-:|:-:|:-:|
| Temp / humidity / weight | ✓ | ✓ | ✓ |
| Sound analysis | — | ✓ (0–1.4 kHz) | ✓ (0–16 kHz, multi-model) |
| Entrance vision (bee count) | — | — | ✓ |
| Phoretic-varroa vision | — | — | ✓ |
| Per-frame thermal map | — | — | ✓ |
| Multi-modal fusion Colony Health Score | — | — | ✓ |
| Explainable predictions (evidence chain) | — | — | ✓ |
| LLM advisor (chat) | — | — | ✓ |
| Weekly digest emails | — | partial | ✓ |
| Cross-apiary baselines | — | — | ✓ (Phase 3) |
| Federated learning | — | — | ✓ (Phase 3) |

The checklist is the pitch. Every row is a model, a Prisma table, and an agent instruction in this document.

---

## 14. Open Questions

1. **Audio upload volume.** 1 clip/hour/hive × 10 s × 16-bit mono 16 kHz ≈ 320 KB. 24 clips/day/hive ≈ 7.7 MB/day/hive. At 100 hives, 770 MB/day. Edge-feature-only shipping cuts this 40×. Decision needed on whether we keep raw audio long enough to retrain (24 h hot, 7 d warm proposal here).
2. **Frame photo cadence.** User-initiated vs. we prompt weekly? Prompting increases label yield but hurts retention if nagged.
3. **Queen-cell vision.** Highest-value detection but hardest dataset. Decision: defer to Phase 3 or pursue earlier via a synthetic-data push?
4. **Privacy default.** Do customers opt in to federated baselines by default, or opt out? Legal recommends opt-in; product wants opt-out. TBD.

---

## 15. Companion Documents

- `beekeeping/hardware/HARDWARE_SPEC.md` — sensor stack and hub architecture
- `beekeeping/ARCHITECTURE.md` — existing web/API/db architecture
- `beekeeping/CLAUDE.md` — data-safety rules (migrations must be additive; all §6 tables comply)

---

## Critical Files for Implementation (when spec is adopted)

- `/Users/michaelthom/Claud/beekeeping/packages/db/prisma/schema.prisma` — add §6 models via an additive migration.
- `/Users/michaelthom/Claud/beekeeping/apps/api/src/llm/advisor.ts` (new) — prompt assembly, tool-use loop, digest generator.
- `/Users/michaelthom/Claud/beekeeping/apps/api/src/ml/fusion.ts` (new) — CHS calculator + rule-based predictors (Phase 1).
- `/Users/michaelthom/Claud/beekeeping/apps/api/src/ml/predictions.ts` (new) — per-model entry points writing to `Prediction` table with Evidence.
- `/Users/michaelthom/Claud/beekeeping/hardware/HARDWARE_SPEC.md` — cross-link; no edits in this plan.
