// Hub config — env-driven, reloadable from API via GET /api/v1/hubs/config.

import fs from "node:fs";
import path from "node:path";

const DEFAULTS = {
  apiBaseUrl: "https://beekeeper-api-production.up.railway.app",
  // X-Hub-Key value. Obtained once at registration (POST /api/v1/hubs/register).
  hubKey: "",
  // How often to drain the local buffer and POST to /ingest.
  uploadIntervalSec: 60,
  // Max readings per POST.
  batchSize: 200,
  // How often to POST heartbeat.
  heartbeatIntervalSec: 300,
  // Data dir for SQLite buffer + logs.
  dataDir: "/var/lib/beekeeper-hub",
  // Device registry (mac -> { hiveId, vendor, type }). Synced from API.
  deviceRegistry: { devices: [] },
};

function loadConfig() {
  const cfg = { ...DEFAULTS };

  // Env overrides
  if (process.env.BEEKEEPER_API_URL) cfg.apiBaseUrl = process.env.BEEKEEPER_API_URL;
  if (process.env.BEEKEEPER_HUB_KEY) cfg.hubKey = process.env.BEEKEEPER_HUB_KEY;
  if (process.env.BEEKEEPER_DATA_DIR) cfg.dataDir = process.env.BEEKEEPER_DATA_DIR;

  // Optional JSON config file override
  const cfgPath = process.env.BEEKEEPER_CONFIG ?? "/etc/beekeeper-hub/config.json";
  if (fs.existsSync(cfgPath)) {
    try {
      const disk = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      Object.assign(cfg, disk);
    } catch (err) {
      console.error(`[config] failed to parse ${cfgPath}:`, err.message);
    }
  }

  // Ensure data dir exists
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  if (!cfg.hubKey) {
    console.warn("[config] BEEKEEPER_HUB_KEY is not set. /ingest calls will 401.");
  }

  return cfg;
}

export { loadConfig };
