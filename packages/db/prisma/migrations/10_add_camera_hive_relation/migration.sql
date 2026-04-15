-- Add hiveId and unifiDeviceId to camera_devices (additive only)
ALTER TABLE "camera_devices" ADD COLUMN IF NOT EXISTS "hive_id" UUID;
ALTER TABLE "camera_devices" ADD COLUMN IF NOT EXISTS "unifi_device_id" TEXT;

-- Set default for unifi_device_id on existing rows (if any)
UPDATE "camera_devices" SET "unifi_device_id" = id::text WHERE "unifi_device_id" IS NULL;

-- Make unifi_device_id NOT NULL after backfill
ALTER TABLE "camera_devices" ALTER COLUMN "unifi_device_id" SET NOT NULL;

-- Add foreign key to hives
ALTER TABLE "camera_devices" ADD CONSTRAINT "camera_devices_hive_id_fkey"
  FOREIGN KEY ("hive_id") REFERENCES "hives"("id") ON DELETE SET NULL ON UPDATE CASCADE;
