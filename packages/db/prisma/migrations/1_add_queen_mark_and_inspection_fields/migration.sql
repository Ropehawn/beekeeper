-- Add queen mark color to hives (hive-level property)
ALTER TABLE "hives" ADD COLUMN "queen_mark_color" TEXT;

-- Add egg/larvae/capped brood observation fields to inspections
ALTER TABLE "inspections" ADD COLUMN "eggs_present" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "inspections" ADD COLUMN "larvae_present" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "inspections" ADD COLUMN "capped_brood" BOOLEAN NOT NULL DEFAULT false;
