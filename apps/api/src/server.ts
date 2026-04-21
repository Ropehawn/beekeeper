import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { db } from "@beekeeper/db";
import { logger } from "./lib/logger";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { hivesRouter } from "./routes/hives";
import { inspectionsRouter } from "./routes/inspections";
import { feedingRouter } from "./routes/feeding";
import { financialsRouter } from "./routes/financials";
import { receiptsRouter } from "./routes/receipts";
import { harvestRouter } from "./routes/harvest";
import { healthEventsRouter } from "./routes/health-events";
import { tasksRouter } from "./routes/tasks";
import { framePhotosRouter } from "./routes/frame-photos";
import { framePhotoActionsRouter } from "./routes/frame-photo-actions";
import { frameObservationsRouter } from "./routes/frame-observations";
import { varroaCountsRouter } from "./routes/varroa-counts";
import { treatmentLogsRouter } from "./routes/treatment-logs";
import { alertsRouter } from "./routes/alerts";
import { scoresRouter } from "./routes/scores";
import { hiveSummaryRouter } from "./routes/hive-summary";
import { sensorsRouter } from "./routes/sensors";
import { hubsRouter } from "./routes/hubs";
import { hubObserveRouter } from "./routes/hub-observe";
import { sensorIdentityQueueRouter } from "./routes/sensor-identity-queue";
import { nodeHealthRouter } from "./routes/node-health";
import { hiveCoverageRouter } from "./routes/hive-coverage";
import { camerasRouter } from "./routes/cameras";
import { healthAnalysisRouter } from "./routes/health-analysis";
import { getSchedulerStatus } from "./jobs/scheduler";

// ── Startup environment validation ───────────────────────────────────────────
// Required: app must not start without these — fail fast with a clear message.
const REQUIRED_ENV = ["DATABASE_URL", "JWT_SECRET"] as const;
// Expected: features degrade silently at runtime without these — warn only.
const EXPECTED_ENV = [
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "ANTHROPIC_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "API_URL",
  "UNIFI_API_KEY",
  "UNIFI_HOST_ID",
] as const;

for (const v of REQUIRED_ENV) {
  if (!process.env[v]) {
    logger.error({ var: v }, "Missing required env var — exiting");
    process.exit(1);
  }
}
for (const v of EXPECTED_ENV) {
  if (!process.env[v]) {
    logger.warn({ var: v }, "Missing expected env var — related features will fail at runtime");
  }
}

// ── Rate limiter — auth endpoints only ───────────────────────────────────────
// 20 requests per IP per 15 minutes. Generous enough for legitimate use,
// tight enough to block automated credential-stuffing and password-spray attacks.
const authLimiter = rateLimit({
  windowMs:       15 * 60 * 1_000,
  max:            20,
  standardHeaders: true,   // Return RateLimit-* headers per RFC 6585
  legacyHeaders:  false,
  message:        { error: "Too many requests — please try again later." },
});

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",")
    : [process.env.WEB_URL || "http://localhost:3000"],
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));

// Scheduler observability — last-run status, errors, and enabled/disabled state
app.get("/health/scheduler", (_req, res) => {
  res.json(getSchedulerStatus());
});

// Health check — probes the database so Railway deploy gates on real connectivity
app.get("/health", async (_req, res) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ status: "ok", service: "beekeeper-api" });
  } catch (err) {
    logger.error({ err: (err as Error).message }, "Health check: database probe failed");
    res.status(503).json({ status: "error", service: "beekeeper-api", detail: "database unavailable" });
  }
});

// API routes
app.use("/api/v1/auth", authLimiter, authRouter);
app.use("/api/v1/users", usersRouter);
app.use("/api/v1/hives", hiveCoverageRouter); // must be before hivesRouter (/:id would swallow /coverage)
app.use("/api/v1/hives", hivesRouter);
app.use("/api/v1/inspections", inspectionsRouter);
app.use("/api/v1/feeding", feedingRouter);
app.use("/api/v1/financials", financialsRouter);
app.use("/api/v1/receipts", receiptsRouter);
app.use("/api/v1/harvest", harvestRouter);
app.use("/api/v1/health-events", healthEventsRouter);
app.use("/api/v1/tasks", tasksRouter);
app.use("/api/v1/frames", framePhotosRouter);
app.use("/api/v1/frame-photos", framePhotoActionsRouter);
app.use("/api/v1/frame-observations", frameObservationsRouter);
app.use("/api/v1/varroa-counts", varroaCountsRouter);
app.use("/api/v1/treatment-logs", treatmentLogsRouter);
app.use("/api/v1/alerts", alertsRouter);
app.use("/api/v1/scores", scoresRouter);
app.use("/api/v1/hive-summary", hiveSummaryRouter);
app.use("/api/v1/sensors", sensorsRouter);
app.use("/api/v1/hubs", hubsRouter);
app.use("/api/v1/hubs", hubObserveRouter);
app.use("/api/v1/sensor-identity", sensorIdentityQueueRouter);
app.use("/api/v1/hubs", nodeHealthRouter);
app.use("/api/v1/cameras", camerasRouter);
app.use("/api/v1/health-analysis", healthAnalysisRouter);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  logger.info({ port: PORT }, "API started");
});

export default app;
