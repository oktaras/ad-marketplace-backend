-- AlterTable
ALTER TABLE "brief_applications"
ADD COLUMN "selectedAdFormatIds" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
