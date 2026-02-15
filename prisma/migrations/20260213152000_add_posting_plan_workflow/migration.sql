-- Add new workflow statuses for posting-plan stage.
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'AWAITING_POSTING_PLAN';
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'POSTING_PLAN_AGREED';
ALTER TYPE "DealStatus" ADD VALUE IF NOT EXISTS 'AWAITING_MANUAL_POST';

-- Posting-plan proposal enums.
CREATE TYPE "PostingPlanMethod" AS ENUM ('AUTO', 'MANUAL');
CREATE TYPE "PostingPlanActor" AS ENUM ('ADVERTISER', 'PUBLISHER');
CREATE TYPE "PostingPlanProposalStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COUNTERED');

-- Deal-level posting-plan fields.
ALTER TABLE "deals"
ADD COLUMN "postingMethod" "PostingPlanMethod",
ADD COLUMN "postingGuaranteeTermHours" INTEGER,
ADD COLUMN "manualPostWindowHours" INTEGER,
ADD COLUMN "postingPlanAgreedAt" TIMESTAMP(3);

-- Persist posting-plan proposals for both parties.
CREATE TABLE "deal_posting_plan_proposals" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "proposedBy" "PostingPlanActor" NOT NULL,
    "method" "PostingPlanMethod" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "windowHours" INTEGER,
    "guaranteeTermHours" INTEGER NOT NULL DEFAULT 48,
    "status" "PostingPlanProposalStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_posting_plan_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "deal_posting_plan_proposals_dealId_createdAt_idx"
ON "deal_posting_plan_proposals"("dealId", "createdAt");

CREATE INDEX "deal_posting_plan_proposals_dealId_status_idx"
ON "deal_posting_plan_proposals"("dealId", "status");

ALTER TABLE "deal_posting_plan_proposals"
ADD CONSTRAINT "deal_posting_plan_proposals_dealId_fkey"
FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
