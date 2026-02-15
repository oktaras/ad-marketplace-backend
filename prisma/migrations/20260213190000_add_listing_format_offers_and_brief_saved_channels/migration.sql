-- Multi-format listing support.
CREATE TABLE "listing_format_offers" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "adFormatId" TEXT NOT NULL,
    "customPrice" TEXT,
    "customCurrency" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "listing_format_offers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "listing_format_offers_listingId_adFormatId_key"
ON "listing_format_offers"("listingId", "adFormatId");

CREATE INDEX "listing_format_offers_listingId_enabled_idx"
ON "listing_format_offers"("listingId", "enabled");

CREATE INDEX "listing_format_offers_adFormatId_idx"
ON "listing_format_offers"("adFormatId");

ALTER TABLE "listing_format_offers"
ADD CONSTRAINT "listing_format_offers_listingId_fkey"
FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "listing_format_offers"
ADD CONSTRAINT "listing_format_offers_adFormatId_fkey"
FOREIGN KEY ("adFormatId") REFERENCES "ad_formats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill one offer per legacy listing.
INSERT INTO "listing_format_offers" (
    "id",
    "listingId",
    "adFormatId",
    "customPrice",
    "customCurrency",
    "enabled",
    "createdAt",
    "updatedAt"
)
SELECT
    ("id" || '_legacy_offer')::TEXT,
    "id",
    "adFormatId",
    "customPrice",
    "customCurrency",
    CASE WHEN "status" = 'REMOVED' THEN false ELSE true END,
    "createdAt",
    "updatedAt"
FROM "listings"
WHERE NOT EXISTS (
    SELECT 1
    FROM "listing_format_offers" lfo
    WHERE lfo."listingId" = "listings"."id"
      AND lfo."adFormatId" = "listings"."adFormatId"
);

-- Advertiser saved channels per brief.
CREATE TABLE "brief_saved_channels" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brief_saved_channels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "brief_saved_channels_briefId_channelId_key"
ON "brief_saved_channels"("briefId", "channelId");

CREATE INDEX "brief_saved_channels_briefId_idx"
ON "brief_saved_channels"("briefId");

CREATE INDEX "brief_saved_channels_advertiserId_idx"
ON "brief_saved_channels"("advertiserId");

CREATE INDEX "brief_saved_channels_channelId_idx"
ON "brief_saved_channels"("channelId");

ALTER TABLE "brief_saved_channels"
ADD CONSTRAINT "brief_saved_channels_briefId_fkey"
FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brief_saved_channels"
ADD CONSTRAINT "brief_saved_channels_channelId_fkey"
FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "brief_saved_channels"
ADD CONSTRAINT "brief_saved_channels_advertiserId_fkey"
FOREIGN KEY ("advertiserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
