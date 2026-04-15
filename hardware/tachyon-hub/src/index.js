// Tachyon hub firmware entry point.
//
// Composes BLEScanner + Buffer + Uploader and runs them on timers.
// Systemd unit at systemd/beekeeper-hub.service supervises this process.

import { loadConfig } from "./config.js";
import { Buffer } from "./buffer.js";
import { Uploader } from "./uploader.js";
import { BLEScanner } from "./ble-scanner.js";
import fs from "node:fs";
import os from "node:os";

const START_TIME = Date.now();

function log(level, payload) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...payload });
  console.log(line);
}

function diskFreeGb(path) {
  try {
    const st = fs.statfsSync(path);
    return (st.bavail * st.bsize) / 1e9;
  } catch {
    return null;
  }
}

function cpuTempC() {
  const candidates = [
    "/sys/class/thermal/thermal_zone0/temp",
    "/sys/class/hwmon/hwmon0/temp1_input",
  ];
  for (const p of candidates) {
    try {
      const raw = parseInt(fs.readFileSync(p, "utf8").trim(), 10);
      if (!Number.isFinite(raw)) continue;
      return raw > 1000 ? raw / 1000 : raw;
    } catch {
      /* continue */
    }
  }
  return null;
}

async function main() {
  const cfg = loadConfig();
  const logger = {
    info: (o) => log("info", o),
    warn: (o) => log("warn", o),
    error: (o) => log("error", o),
  };

  logger.info({ msg: "hub.start", apiBaseUrl: cfg.apiBaseUrl, dataDir: cfg.dataDir });

  const buffer = new Buffer(cfg.dataDir);
  const uploader = new Uploader({ ...cfg, buffer, logger });

  // Fetch latest config (device registry, schedule) from API.
  const remote = await uploader.fetchConfig();
  if (remote?.hub?.deviceRegistry) {
    cfg.deviceRegistry = remote.hub.deviceRegistry;
    logger.info({ msg: "config.loaded", devices: cfg.deviceRegistry?.devices?.length ?? 0 });
  }

  // BLE scanner — feeds buffer
  const scanner = new BLEScanner({
    deviceRegistry: cfg.deviceRegistry,
    onReadings: (rows) => buffer.insertMany(rows),
    logger,
  });
  await scanner.start();

  // Upload loop
  setInterval(async () => {
    const res = await uploader.tick();
    if (res.uploaded > 0 || res.pending > 0) {
      logger.info({ msg: "upload.tick", ...res });
    }
  }, cfg.uploadIntervalSec * 1000);

  // Heartbeat loop
  setInterval(async () => {
    await uploader.heartbeat({
      uptimeSec: Math.floor((Date.now() - START_TIME) / 1000),
      cpuTempC: cpuTempC(),
      storageFreeGb: diskFreeGb(cfg.dataDir),
      firmwareVersion: "0.1.0",
    });
  }, cfg.heartbeatIntervalSec * 1000);

  // Daily prune of 7d+ old rows
  setInterval(() => {
    const n = buffer.pruneOld();
    if (n > 0) logger.info({ msg: "buffer.prune", removed: n });
  }, 24 * 60 * 60 * 1000);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info({ msg: "hub.shutdown" });
    try {
      await scanner.stop();
    } catch {
      /* best effort */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
