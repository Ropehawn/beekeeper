import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("@beekeeper/db", () => ({
  db: {
    hive:          { findUnique: vi.fn(), findMany: vi.fn() },
    sensorDevice:  { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    sensorReading: { findFirst: vi.fn(), create: vi.fn() },
  },
  Prisma: {},
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = {
      id: "user-uuid-aaaaaaaa-0000-0000-0000-000000000001",
      email: "test@example.com",
      role: "queen",
      name: "Test Queen",
    };
    next();
  },
}));

vi.mock("../lib/unifi-client", () => ({
  fetchUnifiSensor:    vi.fn(),
  fetchAllUnifiSensors: vi.fn(),
}));

// ── Imports (after mocks) ────────────────────────────────────────────────────

import { sensorsRouter } from "./sensors";
import { db } from "@beekeeper/db";
import { fetchUnifiSensor, fetchAllUnifiSensors } from "../lib/unifi-client";

// ── Test app ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use("/", sensorsRouter);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HIVE_ID    = "aaaaaaaa-0000-0000-0000-000000000001";
const DEVICE_ROW = {
  id:           "bbbbbbbb-0000-0000-0000-000000000001",
  hiveId:       HIVE_ID,
  vendor:       "unifi_protect",
  deviceId:     "cam_abc123",
  name:         "Hive 1 Sensor",
  pollInterval: 60,
  isActive:     true,
  config:       { type: "sensor" },
  createdAt:    new Date("2026-04-01T00:00:00Z"),
};

// A reading recorded 2 minutes ago — treated as stale (> 60 s) by the route
const STALE_READING_ROW = {
  id:         "cccccccc-0000-0000-0000-000000000001",
  deviceId:   DEVICE_ROW.id,
  tempF:      95.0,     // 35 °C exactly
  humidity:   62.0,
  lux:        820.0,
  weight:     null,
  recordedAt: new Date(Date.now() - 2 * 60_000),   // 2 minutes ago
  device:     { name: "Hive 1 Sensor", deviceId: "cam_abc123" },
};

// A reading recorded 10 seconds ago — treated as fresh (< 60 s) by the route
const FRESH_READING_ROW = {
  ...STALE_READING_ROW,
  id:         "dddddddd-0000-0000-0000-000000000001",
  recordedAt: new Date(Date.now() - 10_000),        // 10 seconds ago
};

// ── POST /devices ─────────────────────────────────────────────────────────────

describe("POST /sensors/devices", () => {
  const VALID_PAYLOAD = {
    hiveId:        HIVE_ID,
    unifiDeviceId: "cam_abc123",
    name:          "Hive 1 Sensor",
    pollInterval:  60,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.hive.findUnique).mockResolvedValue({ id: HIVE_ID } as any);
    vi.mocked(db.sensorDevice.findFirst).mockResolvedValue(null); // no existing device
    vi.mocked(db.sensorDevice.create).mockResolvedValue(DEVICE_ROW as any);
  });

  it("returns 400 when unifiDeviceId is missing", async () => {
    const res = await request(app).post("/devices").send({ name: "Sensor" });
    expect(res.status).toBe(400);
    expect(db.sensorDevice.create).not.toHaveBeenCalled();
  });

  it("returns 404 when hiveId is provided but hive does not exist", async () => {
    vi.mocked(db.hive.findUnique).mockResolvedValue(null);

    const res = await request(app).post("/devices").send(VALID_PAYLOAD);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/hive not found/i);
    expect(db.sensorDevice.create).not.toHaveBeenCalled();
  });

  it("creates a new sensor device and returns 201", async () => {
    const res = await request(app).post("/devices").send(VALID_PAYLOAD);

    expect(res.status).toBe(201);
    const data = vi.mocked(db.sensorDevice.create).mock.calls[0][0].data;
    expect(data.vendor).toBe("unifi_protect");
    expect(data.deviceId).toBe("cam_abc123");
    expect(data.name).toBe("Hive 1 Sensor");
    expect(data.hiveId).toBe(HIVE_ID);
    expect(data.pollInterval).toBe(60);
  });

  it("upserts an existing device and returns 200", async () => {
    vi.mocked(db.sensorDevice.findFirst).mockResolvedValue(DEVICE_ROW as any);
    vi.mocked(db.sensorDevice.update).mockResolvedValue({
      ...DEVICE_ROW,
      name: "Updated Sensor",
    } as any);

    const res = await request(app).post("/devices").send({
      ...VALID_PAYLOAD,
      name: "Updated Sensor",
    });

    expect(res.status).toBe(200);
    expect(db.sensorDevice.create).not.toHaveBeenCalled();
    expect(db.sensorDevice.update).toHaveBeenCalledOnce();
    const updateData = vi.mocked(db.sensorDevice.update).mock.calls[0][0].data;
    expect(updateData.name).toBe("Updated Sensor");
  });
});

// ── GET /latest — read-through cache ─────────────────────────────────────────

describe("GET /sensors/latest", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.sensorDevice.findMany).mockResolvedValue([DEVICE_ROW] as any);
    // Default: no readings in DB, UniFi returns null
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(null);
    vi.mocked(fetchUnifiSensor).mockResolvedValue(null);
    process.env.UNIFI_API_KEY  = "test-unifi-key";
    process.env.UNIFI_HOST_ID  = "test-unifi-host";
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  });

  it("returns 400 when hiveId is missing", async () => {
    const res = await request(app).get("/latest");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hiveId/i);
  });

  it("returns 400 when hiveId is not a UUID", async () => {
    const res = await request(app).get("/latest?hiveId=not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns null when no active device is registered for the hive", async () => {
    vi.mocked(db.sensorDevice.findMany).mockResolvedValue([]);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    // No UniFi call when there is no device to poll
    expect(fetchUnifiSensor).not.toHaveBeenCalled();
  });

  it("returns fresh DB reading immediately without calling UniFi", async () => {
    // Fresh reading (< 60 s) → short-circuit; UniFi must NOT be called
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(FRESH_READING_ROW as any);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.tempF).toBe(95.0);
    expect(fetchUnifiSensor).not.toHaveBeenCalled();
    expect(db.sensorReading.create).not.toHaveBeenCalled();
  });

  it("calls UniFi when DB reading is stale, stores and returns fresh data", async () => {
    // First findFirst (fresh check) → null; second findFirst (stale fallback) never reached
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(null);
    vi.mocked(fetchUnifiSensor).mockResolvedValue({ tempC: 35, humidity: 62, lux: 820 });
    vi.mocked(db.sensorReading.create).mockResolvedValue(FRESH_READING_ROW as any);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(fetchUnifiSensor).toHaveBeenCalledOnce();
    expect(fetchUnifiSensor).toHaveBeenCalledWith("cam_abc123", "test-unifi-key", "test-unifi-host");
    expect(db.sensorReading.create).toHaveBeenCalledOnce();

    // Verify °C → °F conversion in the stored data
    const createData = vi.mocked(db.sensorReading.create).mock.calls[0][0].data;
    expect(createData.tempF).toBeCloseTo(95.0, 5);
    expect(createData.humidity).toBe(62);
    expect(createData.lux).toBe(820);
  });

  it("calls UniFi when there is no DB reading at all, stores and returns fresh data", async () => {
    // Both fresh check and stale fallback would return null without UniFi — but
    // UniFi succeeds, so stale fallback is never reached.
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(null);
    vi.mocked(fetchUnifiSensor).mockResolvedValue({ tempC: 28, humidity: 55, lux: 400 });
    vi.mocked(db.sensorReading.create).mockResolvedValue({
      ...FRESH_READING_ROW,
      tempF:    82.4,
      humidity: 55,
      lux:      400,
    } as any);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(fetchUnifiSensor).toHaveBeenCalledOnce();
    expect(db.sensorReading.create).toHaveBeenCalledOnce();
    expect(res.body.humidity).toBe(55);
  });

  it("falls back to stale DB reading when UniFi call fails", async () => {
    // Fresh check → null; UniFi → null (failure); stale fallback → STALE_READING_ROW
    vi.mocked(db.sensorReading.findFirst)
      .mockResolvedValueOnce(null)              // fresh check: no fresh reading
      .mockResolvedValueOnce(STALE_READING_ROW as any); // stale fallback
    vi.mocked(fetchUnifiSensor).mockResolvedValue(null); // UniFi unavailable

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(fetchUnifiSensor).toHaveBeenCalledOnce();
    expect(db.sensorReading.create).not.toHaveBeenCalled();
    // Returns stale data — frontend uses minutesAgo to show "stale" indicator
    expect(res.body.tempF).toBe(95.0);
    expect(res.body.minutesAgo).toBeGreaterThanOrEqual(2);
  });

  it("returns null when there is no DB reading and UniFi call fails", async () => {
    // Both DB lookups return null, UniFi also fails — nothing to return
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(null);
    vi.mocked(fetchUnifiSensor).mockResolvedValue(null);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("returns the reading with all expected fields and a numeric minutesAgo", async () => {
    vi.mocked(db.sensorReading.findFirst).mockResolvedValue(FRESH_READING_ROW as any);

    const res = await request(app).get(`/latest?hiveId=${HIVE_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.hiveId).toBe(HIVE_ID);
    expect(res.body.tempF).toBe(95.0);
    expect(res.body.humidity).toBe(62.0);
    expect(res.body.lux).toBe(820.0);
    expect(res.body.deviceName).toBe("Hive 1 Sensor");
    expect(typeof res.body.minutesAgo).toBe("number");
    expect(res.body.minutesAgo).toBeGreaterThanOrEqual(0);
    expect(res.body.recordedAt).toBeDefined();
  });
});

// ── GET /test-connection ──────────────────────────────────────────────────────

describe("GET /sensors/test-connection", () => {
  const savedEnv = { ...process.env };
  const globalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UNIFI_API_KEY = "test-unifi-key";
    process.env.UNIFI_HOST_ID = "test-unifi-host";
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
    global.fetch = globalFetch;
  });

  it("returns connected:false when UNIFI_API_KEY is not set", async () => {
    delete process.env.UNIFI_API_KEY;

    const res = await request(app).get("/test-connection");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toMatch(/UNIFI_API_KEY/i);
  });

  it("returns connected:false when api.ui.com returns 401", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      text: async () => "Unauthorized",
    } as unknown as Response);

    const res = await request(app).get("/test-connection");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.error).toMatch(/401/);
  });

  it("returns connected:true with sensorCount when UniFi call succeeds", async () => {
    const sensorPayload = [
      { id: "s1", name: "Sensor 1", stats: { temperature: { value: 35 } }, state: "CONNECTED" },
      { id: "s2", name: "Sensor 2", stats: { temperature: { value: 33 } }, state: "CONNECTED" },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify(sensorPayload),
      json: async () => sensorPayload,
    } as unknown as Response);

    vi.mocked(fetchAllUnifiSensors).mockResolvedValue([
      { id: "s1", name: "Sensor 1", type: "temperature", connected: true, tempF: 95, humidity: 62, lux: 820 },
      { id: "s2", name: "Sensor 2", type: "temperature", connected: true, tempF: 91, humidity: 58, lux: 710 },
    ]);

    const res = await request(app).get("/test-connection");

    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.sensorCount).toBe(2);
  });
});

// ── GET /discover ─────────────────────────────────────────────────────────────

describe("GET /sensors/discover", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.UNIFI_API_KEY = "test-unifi-key";
    process.env.UNIFI_HOST_ID = "test-unifi-host";
  });

  afterEach(() => {
    Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
    Object.assign(process.env, savedEnv);
  });

  it("returns 503 when UNIFI_API_KEY is not set", async () => {
    delete process.env.UNIFI_API_KEY;

    const res = await request(app).get("/discover");

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/UNIFI_API_KEY/i);
  });

  it("returns 503 when UNIFI_HOST_ID is not set", async () => {
    delete process.env.UNIFI_HOST_ID;

    const res = await request(app).get("/discover");

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/UNIFI_HOST_ID/i);
  });

  it("returns 502 when UniFi API call fails", async () => {
    vi.mocked(fetchAllUnifiSensors).mockResolvedValue(null);

    const res = await request(app).get("/discover");

    expect(res.status).toBe(502);
  });

  it("returns sensors array from UniFi API", async () => {
    const mockSensors = [
      { id: "s1", name: "Hive 1 Sensor", type: "temperature", connected: true, tempF: 95, humidity: 62, lux: 820 },
    ];
    vi.mocked(fetchAllUnifiSensors).mockResolvedValue(mockSensors);

    const res = await request(app).get("/discover");

    expect(res.status).toBe(200);
    expect(res.body.sensors).toHaveLength(1);
    expect(res.body.sensors[0].id).toBe("s1");
    expect(res.body.sensors[0].tempF).toBe(95);
  });
});

// ── GET /devices ──────────────────────────────────────────────────────────────

describe("GET /sensors/devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty array when no devices are registered", async () => {
    vi.mocked(db.sensorDevice.findMany).mockResolvedValue([]);

    const res = await request(app).get("/devices");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns registered devices with hive name", async () => {
    vi.mocked(db.sensorDevice.findMany).mockResolvedValue([DEVICE_ROW as any]);
    vi.mocked(db.hive.findMany).mockResolvedValue([
      { id: HIVE_ID, name: "Hive 1" } as any,
    ]);

    const res = await request(app).get("/devices");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].deviceId).toBe("cam_abc123");
    expect(res.body[0].hiveName).toBe("Hive 1");
    expect(res.body[0].hiveId).toBe(HIVE_ID);
  });

  it("returns hiveName as null when device has no linked hive", async () => {
    vi.mocked(db.sensorDevice.findMany).mockResolvedValue([
      { ...DEVICE_ROW, hiveId: null } as any,
    ]);
    vi.mocked(db.hive.findMany).mockResolvedValue([]);

    const res = await request(app).get("/devices");

    expect(res.status).toBe(200);
    expect(res.body[0].hiveId).toBeNull();
    expect(res.body[0].hiveName).toBeNull();
  });
});

// ── DELETE /devices/:id ───────────────────────────────────────────────────────

describe("DELETE /sensors/devices/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.sensorDevice.findUnique).mockResolvedValue(DEVICE_ROW as any);
    vi.mocked(db.sensorDevice.update).mockResolvedValue({ ...DEVICE_ROW, isActive: false } as any);
  });

  it("returns 400 when id is not a UUID", async () => {
    const res = await request(app).delete("/devices/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("returns 404 when device does not exist", async () => {
    vi.mocked(db.sensorDevice.findUnique).mockResolvedValue(null);

    const res = await request(app).delete(`/devices/${DEVICE_ROW.id}`);

    expect(res.status).toBe(404);
  });

  it("soft-deletes device by setting isActive:false and returns ok:true", async () => {
    const res = await request(app).delete(`/devices/${DEVICE_ROW.id}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(db.sensorDevice.update).toHaveBeenCalledOnce();
    const updateData = vi.mocked(db.sensorDevice.update).mock.calls[0][0].data;
    expect(updateData.isActive).toBe(false);
  });
});
