# Beekeeping Web App — Architecture Plan
**Owner:** Michael Thom / ThomDigital Group
**Design principle:** Every value database-driven, zero hardcoded content

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | Next.js 14 (App Router) + TypeScript | SSR, routing, auth middleware, fast mobile loading |
| 3D Rendering | React Three Fiber + @react-three/drei | Declarative Three.js — state flows directly to 3D model |
| Backend | Node.js / Express API (separate Railway service) | WebSocket support, ports existing server.js patterns |
| Database | PostgreSQL (Railway plugin) + Prisma ORM | Relational, ACID, type-safe schema, migrations |
| Real-time | WebSocket (ws) + Redis pub/sub | Sensor readings broadcast to all clients |
| Auth | NextAuth.js (Google OAuth) + JWT | Mirrors existing Google OAuth pattern |
| Video | HLS via Nginx + FFmpeg sidecar | RTSP → HLS for browser playback via hls.js |
| Sensors | Polling microservice (vendor-agnostic adapter pattern) | Swap sensor providers via config, not code changes |
| Deployment | Railway (3 services + plugins) | Existing account/pattern |
| CSS | Tailwind CSS + shadcn/ui | Modern, mobile-first, accessible primitives |

---

## User Roles

| Role | Access |
|------|--------|
| **Queen** (Admin) | Everything: financials, user management, sensor config, camera config, all worker features |
| **Worker** | Inspection logs, feeding logs, health events, task management, 3D hive view, live sensors |
| **Spectator** | Live camera feeds + 3D hive visualization (read-only) + live sensor data + statistics dashboard (health score, temps, feeding schedule, honey production, frame status) |

---

## Railway Services

```
beekeeper-web       → Next.js frontend
beekeeper-api       → Express + WebSocket API
beekeeper-sensors   → Node.js sensor polling worker
beekeeper-stream    → Nginx + FFmpeg RTSP→HLS (Phase 4)
[Plugin] Postgres
[Plugin] Redis
```

---

## Database Schema (Key Tables)

```
apiaries            → property/location
hives               → individual colonies (Hive 1, Hive 2)
hive_components     → stack of boxes per hive (drives 3D model)
frames              → per-frame status within each box
inspections         → full inspection records
feeding_logs        → syrup type, amount, date
health_events       → disease, treatment, swarm, queen events
harvest_logs        → honey weight, date, sales
sensor_devices      → device config (vendor, API key ref, poll interval)
sensor_readings     → time-series temp/humidity/lux (partitioned by month)
camera_devices      → UniFi camera config
tasks               → assigned responsibilities with status
financial_transactions → all purchases and honey sales
financial_line_items → line items per transaction
users               → auth, role, invite tracking
```

---

## 3D Hive Visualization

- **Library:** React Three Fiber + drei
- **Data-driven:** fetches `/api/v1/hives/:id/components` → renders stack bottom-to-top
- **Components rendered:** bottom board → entrance reducer → brood box(es) → queen excluder → honey super(s) → top feeder → inner cover → outer cover
- **Interaction:** click any box → frame grid overlay showing comb %, brood %, honey % per frame
- **Two hives:** side-by-side on X axis, shared orbit controls
- **Mobile:** tab switcher for one hive at a time

---

## Sensor / Camera Integration

### Environmental Sensors
- Vendor-agnostic adapter pattern (`SensorAdapter` interface)
- Adapters: SensorPush, Ecowitt, Generic REST
- API keys stored as env var references only (never in DB)
- Poll every 60 seconds → write to `sensor_readings` → publish to Redis → WebSocket to browsers

### Ubiquiti UniFi Protect
- Auth to local UniFi console via env vars (never exposed to browser)
- Snapshot proxy via API endpoint
- RTSP → HLS via Nginx/FFmpeg sidecar → hls.js in browser

---

## Page Map

```
/dashboard          → Statistics dashboard (all roles — Spectator default landing)
/hives              → Side-by-side 3D view of both hives (all roles — read-only for Spectator)
/hives/[id]         → Single hive: 3D + live sensors + camera + history (all roles — read-only for Spectator)
/hives/[id]/inspect → Full inspection form (Worker, Queen)
/hives/[id]/feed    → Feeding log entry (Worker, Queen)
/hives/[id]/health  → Health event log (Worker, Queen)
/tasks              → Task board / Kanban (Worker, Queen)
/financials         → Financial tracker (Queen only)
/stream             → Live camera view (all roles)
/admin/users        → User management (Queen only)
/admin/sensors      → Sensor config (Queen only)
/admin/cameras      → Camera config (Queen only)
```

### Access Matrix

| Page / Feature | 👑 Queen | 🐝 Worker | 👁️ Spectator |
|----------------|---------|---------|------------|
| Statistics Dashboard | ✅ Full | ✅ Full | ✅ Read-only |
| 3D Hive Visualization | ✅ Full | ✅ Full | ✅ Read-only |
| Live Sensor Data | ✅ Full | ✅ Full | ✅ Read-only |
| Live Camera Feed | ✅ | ✅ | ✅ |
| Frame Detail (click box) | ✅ Edit | ✅ Edit | ✅ View-only |
| Inspection Logs | ✅ Edit | ✅ Edit | ❌ |
| Feeding Logs | ✅ Edit | ✅ Edit | ❌ |
| Health Events | ✅ Edit | ✅ Edit | ❌ |
| Task Board | ✅ Edit | ✅ Edit | ❌ |
| Financials | ✅ Full | ❌ | ❌ |
| User Management | ✅ | ❌ | ❌ |
| Sensor Config | ✅ | ❌ | ❌ |
| Camera Config | ✅ | ❌ | ❌ |

---

## Phased Build Plan

### Phase 1 — Foundation (Weeks 1–2) — Target: Before April 18
- Railway project + Postgres setup
- Monorepo scaffold (Next.js + Express)
- Prisma schema + migrations
- Google OAuth (NextAuth)
- Seed DB with existing data (apiary, 2 hives, Mann Lake purchases)
- Inspection form + feeding log
- Basic dashboard
- Resend email integration (invite + password reset)
- **✅ Deployable and usable on hive install day**

### Phase 2 — 3D Visualization (Weeks 3–4)
- React Three Fiber setup
- HiveModel + ComponentMesh (data-driven)
- Frame overlay click interaction
- Add/remove box UI
- Mobile optimization

### Phase 3 — Sensor Integration (Weeks 5–6)
- Sensor polling worker service
- Vendor adapter (SensorPush or Ecowitt)
- WebSocket real-time broadcasts
- LiveSensorPanel + SensorHistoryChart

### Phase 4 — Camera Integration (Weeks 7–8)
- Nginx + FFmpeg RTSP→HLS sidecar
- Snapshot proxy
- CameraPlayer (hls.js)
- Live stream page

### Phase 5 — Tasks & Financials (Weeks 9–10)
- Kanban task board
- Financial CRUD (pre-populate Mann Lake orders)
- Financial summary + ROI

### Phase 6 — Spectator Dashboard & Polish (Weeks 11–12)
- Curated Spectator view
- Health score algorithm
- Honey fill % estimation
- Harvest projections
- PWA offline support
- Inspection overdue reminder emails (cron, 14-day threshold)
- Low feeder alert emails (sensor-triggered, 24hr rate limit)
- Harvest ready notification emails
- Push notifications (PWA — overdue inspections, low feeder)

---

## Monorepo Structure

```
/beekeeper/
  apps/
    web/          → Next.js frontend
    api/          → Express + WebSocket API
    sensors/      → Polling worker
  packages/
    db/           → Shared Prisma client + schema
    shared/       → Shared TypeScript types, constants, COMPONENT_SPECS
```

---

## Environment Variables

```
DATABASE_URL
NEXTAUTH_SECRET / NEXTAUTH_URL
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
API_URL / AGENT_API_KEY
REDIS_URL
RESEND_API_KEY
EMAIL_FROM                              (e.g. noreply@yourdomain.com)
SENSORPUSH_EMAIL / SENSORPUSH_PASSWORD  (or ECOWITT keys)
UNIFI_HOST / UNIFI_USERNAME / UNIFI_PASSWORD / UNIFI_VERIFY_SSL
HLS_BASE_URL
```

---

## Seed Data (from PROJECT.md)
- Apiary: 364 Rowayton Ave, Norwalk CT 06853
- Hive 1 + Hive 2: Buckfast, Mann Lake, install 2026-04-18
- Order #816651: 2x Buckfast packages — $425.29
- Order #823823: Equipment — $530.51
- Default component stack per hive: bottom board, entrance reducer, 1 brood box (10 frames), inner cover, outer cover, top feeder

---

## Frame Photo Storage

### Storage Backend
- **Provider:** Cloudflare R2 (S3-compatible, free tier 10GB, $0.015/GB after)
- **Why R2 over Railway volumes:** Persistent across deploys, CDN-accessible, cheap, S3 API compatible
- **Estimated usage:** 2 hives × 20 frames × 2 sides × monthly inspections ≈ 80 photos/month ≈ ~400MB/year at 5MB/photo

### Database Table: frame_photos
```
frame_photos
  id                  UUID PK
  frame_id            UUID FK → frames
  inspection_id       UUID FK → inspections
  hive_id             UUID FK → hives
  side                TEXT NOT NULL          -- front | back
  storage_key         TEXT NOT NULL          -- R2 object key (e.g. hives/uuid/frames/uuid/2026-04-18-front.jpg)
  storage_url         TEXT                   -- presigned URL (generated on demand, not stored)
  file_size_bytes     INTEGER
  captured_at         TIMESTAMPTZ NOT NULL
  ai_analysis_json    JSONB                  -- {honey:8, brood:72, open:12, pollen:3, empty:5, confidence:94}
  ai_analyzed_at      TIMESTAMPTZ
  ai_model_version    TEXT                   -- e.g. "claude-3-5-sonnet-20241022"
  notes               TEXT
  created_at          TIMESTAMPTZ
```

### Upload Flow
1. Worker takes photo on mobile during inspection
2. App requests presigned upload URL from API: `POST /api/v1/frames/:id/photos/upload-url`
3. Photo uploaded directly from browser to R2 (bypasses API server — no large file in memory)
4. API records metadata in `frame_photos` table
5. Photo sent to Claude Vision API for analysis (original full-res)
6. AI results stored in `ai_analysis_json` column
7. Frame sliders auto-populated; worker can override

### Historical Viewer
- Frame photo grid: all photos for a specific frame across all inspections
- Timeline view: chronological progression with AI-detected percentages
- Side-by-side comparison: select any two inspection dates to compare front/back photos
- Disease flag: if brood % drops >20% between inspections, flag for review
- Photo never deleted — soft-delete only (is_deleted flag) for audit trail

### Privacy & Security
- R2 bucket is private — no public access
- Photos served via presigned URLs (expire after 1 hour)
- API generates presigned URL on every view request
- Photos accessible to Queen and Worker roles only (not Spectator)
- Spectators see AI-analyzed data (percentages) but not the actual photos

---

## Email

### Provider: Resend
- **Why Resend:** Modern API-first transactional email, React Email template support, 3,000 emails/month free tier, excellent Railway + Next.js compatibility
- **Domain:** Requires a verified sending domain (e.g. `noreply@beekeeping.thomdigital.com` or custom domain)
- **SDK:** `resend` npm package — used in Express API only, never exposed to browser
- **Env var:** `RESEND_API_KEY`

### Email Templates (React Email)
All templates live in `packages/shared/emails/` as React Email components, rendered server-side to HTML before sending.

| Template | File | Trigger |
|----------|------|---------|
| User Invitation | `invite.tsx` | Queen invites new user → sends OTP + login link |
| Password Reset | `password-reset.tsx` | User requests reset → sends reset link (1hr expiry) |
| Inspection Overdue | `inspection-reminder.tsx` | Cron job → inspection not logged in >14 days |
| Low Feeder Alert | `low-feeder.tsx` | Sensor reading → feeder level below threshold |
| Task Assigned | `task-assigned.tsx` | Worker assigned a new task |
| Harvest Ready | `harvest-ready.tsx` | Honey fill % estimate exceeds target (Queen only) |

### Database Table: email_log
```
email_log
  id              UUID PK
  template        TEXT NOT NULL          -- invite | password-reset | inspection-reminder | etc.
  recipient_email TEXT NOT NULL
  recipient_user  UUID FK → users (nullable — pre-registration invites)
  subject         TEXT NOT NULL
  resend_id       TEXT                   -- Resend message ID for delivery tracking
  status          TEXT DEFAULT 'sent'    -- sent | bounced | failed
  metadata_json   JSONB                  -- { hive_id, task_id, otp_hint, etc. }
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
```

### Send Flow (Express API)
```js
// packages/shared/emails/invite.tsx → React Email template
// apps/api/src/email/send.ts

import { Resend } from 'resend';
import { render } from '@react-email/render';
import { InviteEmail } from '@beekeeper/shared/emails/invite';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendInvite(to: string, name: string, otp: string, role: string) {
  const html = render(<InviteEmail name={name} otp={otp} role={role} loginUrl={process.env.NEXTAUTH_URL + '/login'} />);
  const { id } = await resend.emails.send({
    from: 'Beekeeper App <noreply@yourdomain.com>',
    to,
    subject: "You've been invited to Beekeeper",
    html,
  });
  await db.email_log.create({ data: { template: 'invite', recipient_email: to, resend_id: id, metadata_json: { role } } });
}
```

### Use Cases and Triggers

#### 1. User Invitation (Phase 1)
- **Trigger:** Queen submits Invite User form
- **Flow:** Generate 6-digit OTP → store hashed on `users.otp_hash` + `users.otp_expires_at` (24hr) → `sendInvite()` → user receives email → clicks login link → enters OTP → forced to set new password → OTP cleared
- **API:** `POST /api/v1/users/invite`

#### 2. Password Reset (Phase 1)
- **Trigger:** User clicks "Forgot Password" on login screen
- **Flow:** Generate secure token → store hashed on `users.reset_token_hash` + `users.reset_token_expires_at` (1hr) → send email with reset link → user clicks link → sets new password → token cleared
- **API:** `POST /api/v1/auth/forgot-password`, `POST /api/v1/auth/reset-password`
- **Note:** Tokens are single-use and time-limited. Always use `crypto.randomBytes(32).toString('hex')` — never sequential IDs.

#### 3. Inspection Overdue Reminder (Phase 6)
- **Trigger:** Daily cron job (Railway Cron or `node-cron` in sensor worker)
- **Logic:** Query hives where `MAX(inspections.inspected_at) < NOW() - INTERVAL '14 days'` → email all Queen + Worker users
- **Rate limit:** Max 1 reminder per hive per 3 days (tracked in `email_log`)

#### 4. Low Feeder Alert (Phase 6)
- **Trigger:** Sensor polling worker detects feeder level below threshold (configurable per hive in `sensor_devices`)
- **Rate limit:** Max 1 alert per hive per 24hrs (tracked in `email_log`)

#### 5. Task Assigned (Phase 5)
- **Trigger:** Queen creates or reassigns a task to a Worker
- **Flow:** `POST /api/v1/tasks` → if `assigned_to` set → send task-assigned email to that user

### Security
- `RESEND_API_KEY` in env var — never exposed to browser or client
- All email sending happens in Express API layer only
- OTP and reset tokens stored as bcrypt hashes — plaintext never persisted
- `otp_expires_at` and `reset_token_expires_at` enforced server-side on every use attempt
- Invitation emails do not expose the hashed token in URLs — OTP is entered manually

### Environment Variables (add to list)
```
RESEND_API_KEY
EMAIL_FROM=noreply@yourdomain.com
```

### Phase 1 Deliverables (email)
- [ ] Resend account + domain verification
- [ ] `sendInvite()` and `sendPasswordReset()` functions
- [ ] `InviteEmail` and `PasswordResetEmail` React Email templates
- [ ] `email_log` table in Prisma schema
- [ ] `POST /api/v1/users/invite` wired to email
- [ ] `POST /api/v1/auth/forgot-password` + `POST /api/v1/auth/reset-password`

---

## Receipt / Invoice Scanning

> **Wireframe status:** Demo only — `simulateTxnDocUpload()` skips the file picker and returns hardcoded mock data. The real build implements the full flow below.

### Storage Backend
- **Same R2 bucket** as frame photos, separate prefix: `receipts/YYYY/MM/uuid.{pdf,jpg,png}`
- **Estimated usage:** ~5–10 receipts/month × 2MB avg = trivial

### Database Table: receipts
```
receipts
  id                  UUID PK
  transaction_id      UUID FK → financial_transactions (nullable until user saves)
  storage_key         TEXT NOT NULL          -- R2 object key
  file_size_bytes     INTEGER
  mime_type           TEXT                   -- application/pdf | image/jpeg | image/png
  uploaded_at         TIMESTAMPTZ NOT NULL
  uploaded_by         UUID FK → users
  ai_analysis_json    JSONB                  -- structured extraction result (see below)
  ai_analyzed_at      TIMESTAMPTZ
  ai_model_version    TEXT                   -- e.g. "claude-3-5-sonnet-20241022"
  ai_confidence       INTEGER                -- 0–100
  created_at          TIMESTAMPTZ
```

### AI Extraction JSON Shape
```json
{
  "vendor":      "Mann Lake Ltd",
  "date":        "2026-03-31",
  "order_ref":   "#823823",
  "total":       530.51,
  "subtotal":    499.43,
  "tax":         31.08,
  "type":        "expense",
  "category":    "Equipment",
  "description": "Hive equipment — frames, suit, gloves, feeder, covers, entrance reducers",
  "confidence":  97,
  "line_items": [
    { "qty": 2, "sku": "WW895", "description": "9 1/8\" Black Frames (case/20)", "unit_price": 73.99, "amount": 147.98 },
    { "qty": 1, "sku": "VS311", "description": "Vented Beekeeping Suit (L)",     "unit_price": 194.99,"amount": 194.99 }
  ]
}
```

### Real Build Upload Flow
1. User taps "Scan with AI" → browser triggers `<input type="file" accept="image/*,.pdf" capture="environment">`
2. User selects file (camera shot, photo library, or file browser)
3. `POST /api/v1/receipts/upload-url` → Express returns R2 presigned PUT URL + `storageKey`
4. Browser PUTs file **directly to R2** (never through API server — no memory pressure)
5. `POST /api/v1/receipts/scan { storageKey }`:
   - Express fetches file from R2 as buffer
   - For PDF: converts first page to image via `pdf2pic` or `sharp`
   - Sends to Claude Vision API:
     ```js
     messages: [{
       role: 'user',
       content: [
         { type: 'image', source: { type: 'base64', media_type, data: base64 } },
         { type: 'text',  text: RECEIPT_EXTRACTION_PROMPT }
       ]
     }]
     ```
   - `RECEIPT_EXTRACTION_PROMPT` instructs Claude to return the JSON shape above
   - Response parsed + validated → stored in `ai_analysis_json`
6. Structured result returned to browser → form fields auto-populated
7. User reviews, edits if needed, clicks Save
8. `POST /api/v1/transactions` saves to `financial_transactions` + links `receipt.transaction_id`

### Claude Vision Prompt (RECEIPT_EXTRACTION_PROMPT)
```
You are extracting structured data from a receipt or invoice image.
Return ONLY valid JSON matching this exact schema — no prose, no markdown:
{
  "vendor": string,
  "date": "YYYY-MM-DD",
  "order_ref": string | null,
  "total": number,
  "tax": number | null,
  "type": "expense" | "income",
  "category": "Equipment" | "Bees" | "Supplies" | "Treatment" | "Honey Sales" | "Other",
  "description": string,
  "confidence": number (0-100),
  "line_items": [{ "qty": number|null, "sku": string|null, "description": string, "unit_price": number|null, "amount": number }]
}
If a field cannot be determined, use null.
```

### API Endpoints (Express)
```
POST /api/v1/receipts/upload-url     → { presignedUrl, storageKey }
POST /api/v1/receipts/scan           → { aiResult, storageKey, receiptId }
GET  /api/v1/receipts/:id/download   → presigned GET URL (Queen/Worker only)
```

### Security
- R2 bucket private — no public access
- Receipts accessible to Queen role only (financial data)
- Presigned download URLs expire after 1 hour
- Claude API key in `ANTHROPIC_API_KEY` env var — never exposed to browser
