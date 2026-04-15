-- Add missing inspection form fields
ALTER TABLE "inspections" ADD COLUMN "laying_pattern" TEXT;
ALTER TABLE "inspections" ADD COLUMN "frames_bees" INTEGER;
ALTER TABLE "inspections" ADD COLUMN "frames_brood" INTEGER;
ALTER TABLE "inspections" ADD COLUMN "frames_honey" INTEGER;
ALTER TABLE "inspections" ADD COLUMN "frames_pollen" INTEGER;
ALTER TABLE "inspections" ADD COLUMN "next_inspection_date" TIMESTAMP(3);

-- Add missing feeding log fields
ALTER TABLE "feeding_logs" ADD COLUMN "feeder_type" TEXT;
