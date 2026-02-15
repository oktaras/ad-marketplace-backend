-- CreateEnum
CREATE TYPE "DealChatStatus" AS ENUM ('PENDING_OPEN', 'ACTIVE', 'CLOSED');

-- CreateTable
CREATE TABLE "deal_chat_bridges" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "status" "DealChatStatus" NOT NULL DEFAULT 'PENDING_OPEN',
    "advertiserThreadId" BIGINT,
    "publisherThreadId" BIGINT,
    "advertiserOpenedAt" TIMESTAMP(3),
    "publisherOpenedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deal_chat_bridges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_chat_bridges_dealId_key" ON "deal_chat_bridges"("dealId");

-- CreateIndex
CREATE INDEX "deal_chat_bridges_status_idx" ON "deal_chat_bridges"("status");

-- CreateIndex
CREATE INDEX "deal_chat_bridges_advertiserThreadId_idx" ON "deal_chat_bridges"("advertiserThreadId");

-- CreateIndex
CREATE INDEX "deal_chat_bridges_publisherThreadId_idx" ON "deal_chat_bridges"("publisherThreadId");

-- CreateIndex
CREATE INDEX "deal_chat_bridges_closedByUserId_idx" ON "deal_chat_bridges"("closedByUserId");

-- AddForeignKey
ALTER TABLE "deal_chat_bridges" ADD CONSTRAINT "deal_chat_bridges_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_chat_bridges" ADD CONSTRAINT "deal_chat_bridges_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
