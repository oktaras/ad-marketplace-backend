-- Add per-user bot auto-alert notification preferences.
ALTER TABLE "users"
  ADD COLUMN "notifyAdvertiserMessages" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyPublisherMessages" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifyPaymentMessages" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notifySystemMessages" BOOLEAN NOT NULL DEFAULT true;
