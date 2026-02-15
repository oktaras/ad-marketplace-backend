/*
  Warnings:

  - You are about to drop the column `avgReach` on the `channel_stats` table. All the data in the column will be lost.
  - You are about to drop the column `avgShares` on the `channel_stats` table. All the data in the column will be lost.
  - You are about to drop the column `avgViews` on the `channel_stats` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "GraphType" AS ENUM ('GROWTH', 'FOLLOWERS', 'INTERACTIONS', 'IV_INTERACTIONS', 'VIEWS_BY_SOURCE', 'FOLLOWERS_BY_SOURCE', 'LANGUAGES', 'REACTIONS_BY_EMOTION', 'STORY_INTERACTIONS', 'STORY_REACTIONS', 'MUTE_GRAPH', 'TOP_HOURS');

-- AlterTable
ALTER TABLE "channel_stats" DROP COLUMN "avgReach",
DROP COLUMN "avgShares",
DROP COLUMN "avgViews",
ADD COLUMN     "avgReactionsPerPost" INTEGER,
ADD COLUMN     "avgReactionsPerPostPrev" INTEGER,
ADD COLUMN     "avgReactionsPerStory" INTEGER,
ADD COLUMN     "avgReactionsPerStoryPrev" INTEGER,
ADD COLUMN     "avgSharesPerPost" INTEGER,
ADD COLUMN     "avgSharesPerPostPrev" INTEGER,
ADD COLUMN     "avgSharesPerStory" INTEGER,
ADD COLUMN     "avgSharesPerStoryPrev" INTEGER,
ADD COLUMN     "avgViewsPerPost" INTEGER,
ADD COLUMN     "avgViewsPerPostPrev" INTEGER,
ADD COLUMN     "avgViewsPerStory" INTEGER,
ADD COLUMN     "avgViewsPerStoryPrev" INTEGER,
ADD COLUMN     "hasAsyncGraphs" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasPostStats" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasSourceData" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notificationEnabledPart" INTEGER,
ADD COLUMN     "notificationEnabledRate" DOUBLE PRECISION,
ADD COLUMN     "notificationEnabledTotal" INTEGER,
ADD COLUMN     "partialDataReason" TEXT,
ADD COLUMN     "periodEnd" TIMESTAMP(3),
ADD COLUMN     "periodStart" TIMESTAMP(3),
ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "storyEngagementRate" DOUBLE PRECISION,
ADD COLUMN     "subscriberCountPrevious" INTEGER;

-- CreateTable
CREATE TABLE "channel_stats_graphs" (
    "id" TEXT NOT NULL,
    "statsId" TEXT NOT NULL,
    "graphType" "GraphType" NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "isAsync" BOOLEAN NOT NULL DEFAULT false,
    "asyncToken" TEXT,
    "loadedAt" TIMESTAMP(3),
    "loadError" TEXT,
    "timestamps" BIGINT[],
    "series" JSONB NOT NULL,
    "title" TEXT,
    "xAxisFormat" TEXT,
    "yAxisFormat" TEXT,
    "rawGraph" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_stats_graphs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "channel_stats_graphs_statsId_graphType_idx" ON "channel_stats_graphs"("statsId", "graphType");

-- CreateIndex
CREATE INDEX "channel_stats_graphs_statsId_periodStart_periodEnd_idx" ON "channel_stats_graphs"("statsId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "channel_stats_subscriberCount_idx" ON "channel_stats"("subscriberCount");

-- CreateIndex
CREATE INDEX "channel_stats_avgViewsPerPost_idx" ON "channel_stats"("avgViewsPerPost");

-- CreateIndex
CREATE INDEX "channel_stats_engagementRate_idx" ON "channel_stats"("engagementRate");

-- CreateIndex
CREATE INDEX "channel_stats_subscriberGrowth30d_idx" ON "channel_stats"("subscriberGrowth30d");

-- CreateIndex
CREATE INDEX "channel_stats_notificationEnabledRate_idx" ON "channel_stats"("notificationEnabledRate");

-- CreateIndex
CREATE INDEX "channel_stats_source_fetchedAt_idx" ON "channel_stats"("source", "fetchedAt");

-- AddForeignKey
ALTER TABLE "channel_stats_graphs" ADD CONSTRAINT "channel_stats_graphs_statsId_fkey" FOREIGN KEY ("statsId") REFERENCES "channel_stats"("id") ON DELETE CASCADE ON UPDATE CASCADE;
