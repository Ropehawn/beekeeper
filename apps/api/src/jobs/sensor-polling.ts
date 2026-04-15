/**
 * Sensor Polling Job
 *
 * Runs every 5 minutes (scheduled by scheduler.ts via node-cron).
 * Fetches readings from all active sensor devices and stores them
 * in the sensor_readings table for historical charting.
 *
 * Per-device error isolation: one device failure does not stop polling
 * of remaining devices.
 */

import { db } from "@beekeeper/db";
import { fetchUnifiSensor } from "../lib/unifi-client";
import { logger } from "../lib/logger";

export async function runSensorPolling(): Promise<void> {
  const apiKey = process.env.UNIFI_API_KEY;
  const hostId = process.env.UNIFI_HOST_ID;
  if (!apiKey || !hostId) {
    logger.info({}, "Sensor polling skipped — UNIFI_API_KEY or UNIFI_HOST_ID not set");
    return;
  }

  const devices = await db.sensorDevice.findMany({
    where: { isActive: true },
    select: { id: true, deviceId: true, name: true, hiveId: true },
  });

  if (devices.length === 0) {
    logger.info({}, "Sensor polling — no active devices registered");
    return;
  }

  let success = 0;
  let failed = 0;

  for (const device of devices) {
    try {
      const reading = await fetchUnifiSensor(device.deviceId, apiKey, hostId);
      if (!reading) {
        failed++;
        continue;
      }

      const tempF = reading.tempC != null ? Math.round(((reading.tempC * 9) / 5 + 32) * 100) / 100 : null;

      await db.sensorReading.create({
        data: {
          id: crypto.randomUUID(),
          deviceId: device.id,
          tempF,
          humidity: reading.humidity,
          lux: reading.lux,
          weight: null,
          recordedAt: new Date(),
        },
      });

      success++;
    } catch (err) {
      failed++;
      logger.warn(
        { deviceId: device.deviceId, deviceName: device.name, err: err instanceof Error ? err.message : String(err) },
        "Sensor polling failed for device"
      );
    }
  }

  logger.info({ total: devices.length, success, failed }, "Sensor polling round complete");
}
