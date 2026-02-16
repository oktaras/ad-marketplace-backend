-- Cleanup of unused tables in requested order:
-- 1) platform_wallets
-- 2) scheduled_jobs
-- 3) deal_messages

-- 1) platform_wallets
DROP TABLE IF EXISTS "platform_wallets";
DROP TYPE IF EXISTS "NetworkType";
DROP TYPE IF EXISTS "WalletPurpose";

-- 2) scheduled_jobs
DROP TABLE IF EXISTS "scheduled_jobs";
DROP TYPE IF EXISTS "JobStatus";

-- 3) deal_messages
DROP TABLE IF EXISTS "deal_messages";
DROP TYPE IF EXISTS "MessageType";
