-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('CHANNEL', 'GROUP', 'SUPERGROUP');

-- CreateEnum
CREATE TYPE "ChannelStatus" AS ENUM ('PENDING', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ChannelMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "StatsSource" AS ENUM ('BOT_API', 'MTPROTO', 'TGSTAT', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdFormatType" AS ENUM ('POST', 'STORY', 'REPOST', 'PINNED', 'OTHER');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'GIF', 'DOCUMENT', 'AUDIO', 'POLL');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'EXPIRED', 'REMOVED');

-- CreateEnum
CREATE TYPE "BriefFlexibility" AS ENUM ('STRICT', 'FLEXIBLE', 'ANYTIME');

-- CreateEnum
CREATE TYPE "BriefStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'SHORTLISTED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DealOrigin" AS ENUM ('LISTING', 'BRIEF', 'DIRECT');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('CREATED', 'NEGOTIATING', 'TERMS_AGREED', 'AWAITING_PAYMENT', 'FUNDED', 'AWAITING_CREATIVE', 'CREATIVE_SUBMITTED', 'CREATIVE_REVISION', 'CREATIVE_APPROVED', 'SCHEDULED', 'POSTING', 'POSTED', 'VERIFIED', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'DISPUTED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('NONE', 'PENDING', 'HELD', 'RELEASING', 'RELEASED', 'REFUNDING', 'REFUNDED', 'PARTIAL_REFUND');

-- CreateEnum
CREATE TYPE "CreativeStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'POSTED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'SYSTEM', 'PRICE_PROPOSAL', 'TERMS_UPDATE', 'CREATIVE_SUBMIT', 'APPROVAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'ADMIN');

-- CreateEnum
CREATE TYPE "EscrowWalletType" AS ENUM ('HOT', 'DEAL', 'USER');

-- CreateEnum
CREATE TYPE "WalletStatus" AS ENUM ('ACTIVE', 'LOCKED', 'RETIRED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'RELEASE', 'REFUND', 'PARTIAL_RELEASE', 'PARTIAL_REFUND', 'PLATFORM_FEE', 'GAS_TOPUP', 'WITHDRAWAL');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'PROCESSING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DisputeRole" AS ENUM ('ADVERTISER', 'CHANNEL_OWNER');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('POST_NOT_PUBLISHED', 'POST_DELETED_EARLY', 'POST_MODIFIED', 'WRONG_CONTENT', 'WRONG_TIME', 'STATS_MISLEADING', 'NON_RESPONSIVE', 'PAYMENT_ISSUE', 'OTHER');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "DisputeOutcome" AS ENUM ('FULL_REFUND', 'PARTIAL_REFUND', 'FULL_RELEASE', 'PARTIAL_RELEASE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('DEAL_CREATED', 'DEAL_ACCEPTED', 'DEAL_FUNDED', 'CREATIVE_SUBMITTED', 'CREATIVE_APPROVED', 'CREATIVE_REVISION', 'POST_PUBLISHED', 'DEAL_COMPLETED', 'DEAL_CANCELLED', 'BRIEF_APPLICATION', 'APPLICATION_ACCEPTED', 'APPLICATION_REJECTED', 'PAYMENT_RECEIVED', 'PAYMENT_RELEASED', 'PAYMENT_REFUNDED', 'DISPUTE_OPENED', 'DISPUTE_RESOLVED', 'CHANNEL_VERIFIED', 'REVIEW_RECEIVED', 'SYSTEM_ALERT');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('TELEGRAM', 'PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "NetworkType" AS ENUM ('MAINNET', 'TESTNET');

-- CreateEnum
CREATE TYPE "WalletPurpose" AS ENUM ('FEE_COLLECTION', 'GAS_OPERATIONS', 'TREASURY');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "languageCode" TEXT DEFAULT 'en',
    "isPremium" BOOLEAN NOT NULL DEFAULT false,
    "photoUrl" TEXT,
    "isAdvertiser" BOOLEAN NOT NULL DEFAULT false,
    "isChannelOwner" BOOLEAN NOT NULL DEFAULT false,
    "walletAddress" TEXT,
    "walletConnectedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_wallets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "isMain" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verificationTx" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" TEXT NOT NULL,
    "telegramChatId" BIGINT NOT NULL,
    "username" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT NOT NULL,
    "botAddedAt" TIMESTAMP(3),
    "botIsAdmin" BOOLEAN NOT NULL DEFAULT false,
    "botPermissions" JSONB,
    "type" "ChannelType" NOT NULL DEFAULT 'CHANNEL',
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "inviteLink" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "status" "ChannelStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "currentStatsId" TEXT,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_members" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ChannelMemberRole" NOT NULL DEFAULT 'MANAGER',
    "permissions" JSONB NOT NULL,
    "telegramAdminVerifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "invitedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_stats" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "subscriberCount" INTEGER NOT NULL,
    "avgViews" INTEGER,
    "avgReach" INTEGER,
    "avgShares" INTEGER,
    "engagementRate" DOUBLE PRECISION,
    "premiumPercent" DOUBLE PRECISION,
    "languageStats" JSONB,
    "subscriberGrowth7d" INTEGER,
    "subscriberGrowth30d" INTEGER,
    "source" "StatsSource" NOT NULL DEFAULT 'BOT_API',
    "rawData" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameRu" TEXT,
    "nameUk" TEXT,
    "icon" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_formats" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "type" "AdFormatType" NOT NULL DEFAULT 'POST',
    "customType" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceAmount" TEXT NOT NULL,
    "priceCurrency" TEXT NOT NULL DEFAULT 'TON',
    "durationHours" INTEGER NOT NULL DEFAULT 24,
    "maxLength" INTEGER,
    "mediaAllowed" "MediaType"[] DEFAULT ARRAY['IMAGE', 'VIDEO']::"MediaType"[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "availableSlots" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ad_formats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "listings" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "adFormatId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "customPrice" TEXT,
    "customCurrency" TEXT,
    "availableFrom" TIMESTAMP(3),
    "availableTo" TIMESTAMP(3),
    "preferredTimes" JSONB,
    "blackoutDates" TIMESTAMP(3)[],
    "requirements" TEXT,
    "restrictions" TEXT,
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "listings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "briefs" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetCategories" TEXT[],
    "targetLanguages" TEXT[],
    "minSubscribers" INTEGER,
    "maxSubscribers" INTEGER,
    "minAvgViews" INTEGER,
    "budgetMin" TEXT,
    "budgetMax" TEXT,
    "totalBudget" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'TON',
    "desiredStartDate" TIMESTAMP(3),
    "desiredEndDate" TIMESTAMP(3),
    "flexibility" "BriefFlexibility" NOT NULL DEFAULT 'FLEXIBLE',
    "hasCreative" BOOLEAN NOT NULL DEFAULT false,
    "creativeGuidelines" TEXT,
    "sampleCreative" JSONB,
    "status" "BriefStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "briefs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brief_applications" (
    "id" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "proposedPrice" TEXT NOT NULL,
    "proposedDate" TIMESTAMP(3),
    "pitch" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brief_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deals" (
    "id" TEXT NOT NULL,
    "dealNumber" SERIAL NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "channelOwnerId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "origin" "DealOrigin" NOT NULL,
    "listingId" TEXT,
    "briefId" TEXT,
    "applicationId" TEXT,
    "adFormatId" TEXT NOT NULL,
    "agreedPrice" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'TON',
    "scheduledTime" TIMESTAMP(3),
    "durationHours" INTEGER NOT NULL DEFAULT 24,
    "platformFeeBps" INTEGER NOT NULL DEFAULT 500,
    "platformFeeAmount" TEXT,
    "publisherAmount" TEXT,
    "status" "DealStatus" NOT NULL DEFAULT 'CREATED',
    "statusHistory" JSONB NOT NULL DEFAULT '[]',
    "escrowStatus" "EscrowStatus" NOT NULL DEFAULT 'NONE',
    "escrowWalletId" TEXT,
    "escrowAmount" TEXT,
    "escrowTxHash" TEXT,
    "releaseTxHash" TEXT,
    "creativeId" TEXT,
    "postedMessageId" BIGINT,
    "postedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "notes" TEXT,
    "metadata" JSONB,

    CONSTRAINT "deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "text" TEXT,
    "mediaUrls" TEXT[],
    "mediaTypes" "MediaType"[],
    "parseMode" TEXT DEFAULT 'HTML',
    "buttons" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "previousVersions" JSONB NOT NULL DEFAULT '[]',
    "status" "CreativeStatus" NOT NULL DEFAULT 'DRAFT',
    "feedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_messages" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "telegramMessageId" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "deal_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deal_events" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "fromStatus" "DealStatus",
    "toStatus" "DealStatus",
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escrow_wallets" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "publicKey" TEXT,
    "type" "EscrowWalletType" NOT NULL DEFAULT 'DEAL',
    "dealId" TEXT,
    "userId" TEXT,
    "contractAddress" TEXT,
    "deployTxHash" TEXT,
    "isDeployed" BOOLEAN NOT NULL DEFAULT false,
    "status" "WalletStatus" NOT NULL DEFAULT 'ACTIVE',
    "cachedBalance" TEXT NOT NULL DEFAULT '0',
    "lastSyncedAt" TIMESTAMP(3),
    "encryptedKey" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escrow_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" TEXT NOT NULL,
    "walletId" TEXT,
    "dealId" TEXT,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "amount" TEXT NOT NULL,
    "fee" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'TON',
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "txHash" TEXT,
    "lt" BIGINT,
    "blockNumber" BIGINT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "initiatorId" TEXT NOT NULL,
    "initiatorRole" "DisputeRole" NOT NULL,
    "reason" "DisputeReason" NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" JSONB,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "outcome" "DisputeOutcome",
    "advertiserRefundPercent" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "communicationRating" INTEGER,
    "qualityRating" INTEGER,
    "timelinessRating" INTEGER,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'TELEGRAM',
    "telegramMessageId" BIGINT,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_wallets" (
    "id" TEXT NOT NULL,
    "network" "NetworkType" NOT NULL DEFAULT 'TESTNET',
    "purpose" "WalletPurpose" NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "encryptedKey" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "minBalance" TEXT,
    "cachedBalance" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "referenceId" TEXT,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt" TIMESTAMP(3),

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorIp" TEXT,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ChannelToChannelCategory" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ChannelToChannelCategory_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE INDEX "users_telegramId_idx" ON "users"("telegramId");

-- CreateIndex
CREATE INDEX "users_walletAddress_idx" ON "users"("walletAddress");

-- CreateIndex
CREATE INDEX "users_isAdvertiser_isChannelOwner_idx" ON "users"("isAdvertiser", "isChannelOwner");

-- CreateIndex
CREATE UNIQUE INDEX "user_wallets_address_key" ON "user_wallets"("address");

-- CreateIndex
CREATE INDEX "user_wallets_userId_idx" ON "user_wallets"("userId");

-- CreateIndex
CREATE INDEX "user_wallets_address_idx" ON "user_wallets"("address");

-- CreateIndex
CREATE UNIQUE INDEX "channels_telegramChatId_key" ON "channels"("telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "channels_username_key" ON "channels"("username");

-- CreateIndex
CREATE UNIQUE INDEX "channels_currentStatsId_key" ON "channels"("currentStatsId");

-- CreateIndex
CREATE INDEX "channels_ownerId_idx" ON "channels"("ownerId");

-- CreateIndex
CREATE INDEX "channels_status_idx" ON "channels"("status");

-- CreateIndex
CREATE INDEX "channels_language_idx" ON "channels"("language");

-- CreateIndex
CREATE INDEX "channels_telegramChatId_idx" ON "channels"("telegramChatId");

-- CreateIndex
CREATE INDEX "channel_members_userId_idx" ON "channel_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "channel_members_channelId_userId_key" ON "channel_members"("channelId", "userId");

-- CreateIndex
CREATE INDEX "channel_stats_channelId_fetchedAt_idx" ON "channel_stats"("channelId", "fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "channel_categories_slug_key" ON "channel_categories"("slug");

-- CreateIndex
CREATE INDEX "channel_categories_parentId_idx" ON "channel_categories"("parentId");

-- CreateIndex
CREATE INDEX "ad_formats_channelId_isActive_idx" ON "ad_formats"("channelId", "isActive");

-- CreateIndex
CREATE INDEX "listings_channelId_status_idx" ON "listings"("channelId", "status");

-- CreateIndex
CREATE INDEX "listings_status_createdAt_idx" ON "listings"("status", "createdAt");

-- CreateIndex
CREATE INDEX "briefs_advertiserId_status_idx" ON "briefs"("advertiserId", "status");

-- CreateIndex
CREATE INDEX "briefs_status_createdAt_idx" ON "briefs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "brief_applications_briefId_status_idx" ON "brief_applications"("briefId", "status");

-- CreateIndex
CREATE INDEX "brief_applications_applicantId_idx" ON "brief_applications"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "brief_applications_briefId_channelId_key" ON "brief_applications"("briefId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "deals_dealNumber_key" ON "deals"("dealNumber");

-- CreateIndex
CREATE UNIQUE INDEX "deals_applicationId_key" ON "deals"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "deals_creativeId_key" ON "deals"("creativeId");

-- CreateIndex
CREATE INDEX "deals_advertiserId_status_idx" ON "deals"("advertiserId", "status");

-- CreateIndex
CREATE INDEX "deals_channelOwnerId_status_idx" ON "deals"("channelOwnerId", "status");

-- CreateIndex
CREATE INDEX "deals_channelId_status_idx" ON "deals"("channelId", "status");

-- CreateIndex
CREATE INDEX "deals_status_createdAt_idx" ON "deals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "deals_escrowStatus_idx" ON "deals"("escrowStatus");

-- CreateIndex
CREATE UNIQUE INDEX "creatives_dealId_key" ON "creatives"("dealId");

-- CreateIndex
CREATE INDEX "deal_messages_dealId_createdAt_idx" ON "deal_messages"("dealId", "createdAt");

-- CreateIndex
CREATE INDEX "deal_events_dealId_createdAt_idx" ON "deal_events"("dealId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "escrow_wallets_address_key" ON "escrow_wallets"("address");

-- CreateIndex
CREATE INDEX "escrow_wallets_address_idx" ON "escrow_wallets"("address");

-- CreateIndex
CREATE INDEX "escrow_wallets_type_status_idx" ON "escrow_wallets"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_txHash_key" ON "transactions"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_idempotencyKey_key" ON "transactions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "transactions_walletId_createdAt_idx" ON "transactions"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "transactions_dealId_idx" ON "transactions"("dealId");

-- CreateIndex
CREATE INDEX "transactions_txHash_idx" ON "transactions"("txHash");

-- CreateIndex
CREATE INDEX "transactions_status_idx" ON "transactions"("status");

-- CreateIndex
CREATE INDEX "disputes_dealId_idx" ON "disputes"("dealId");

-- CreateIndex
CREATE INDEX "disputes_status_idx" ON "disputes"("status");

-- CreateIndex
CREATE INDEX "reviews_targetId_createdAt_idx" ON "reviews"("targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "reviews_dealId_authorId_key" ON "reviews"("dealId", "authorId");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_key_key" ON "system_config"("key");

-- CreateIndex
CREATE INDEX "platform_wallets_network_isActive_idx" ON "platform_wallets"("network", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "platform_wallets_network_purpose_key" ON "platform_wallets"("network", "purpose");

-- CreateIndex
CREATE INDEX "scheduled_jobs_type_status_scheduledFor_idx" ON "scheduled_jobs"("type", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "scheduled_jobs_referenceId_idx" ON "scheduled_jobs"("referenceId");

-- CreateIndex
CREATE INDEX "audit_logs_resource_resourceId_idx" ON "audit_logs"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "audit_logs_actorId_createdAt_idx" ON "audit_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "_ChannelToChannelCategory_B_index" ON "_ChannelToChannelCategory"("B");

-- AddForeignKey
ALTER TABLE "user_wallets" ADD CONSTRAINT "user_wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channels" ADD CONSTRAINT "channels_currentStatsId_fkey" FOREIGN KEY ("currentStatsId") REFERENCES "channel_stats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_stats" ADD CONSTRAINT "channel_stats_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_categories" ADD CONSTRAINT "channel_categories_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "channel_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_formats" ADD CONSTRAINT "ad_formats_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "listings" ADD CONSTRAINT "listings_adFormatId_fkey" FOREIGN KEY ("adFormatId") REFERENCES "ad_formats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brief_applications" ADD CONSTRAINT "brief_applications_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_channelOwnerId_fkey" FOREIGN KEY ("channelOwnerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "briefs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "brief_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_adFormatId_fkey" FOREIGN KEY ("adFormatId") REFERENCES "ad_formats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deals" ADD CONSTRAINT "deals_escrowWalletId_fkey" FOREIGN KEY ("escrowWalletId") REFERENCES "escrow_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_messages" ADD CONSTRAINT "deal_messages_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deal_events" ADD CONSTRAINT "deal_events_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "escrow_wallets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ChannelToChannelCategory" ADD CONSTRAINT "_ChannelToChannelCategory_A_fkey" FOREIGN KEY ("A") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ChannelToChannelCategory" ADD CONSTRAINT "_ChannelToChannelCategory_B_fkey" FOREIGN KEY ("B") REFERENCES "channel_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
