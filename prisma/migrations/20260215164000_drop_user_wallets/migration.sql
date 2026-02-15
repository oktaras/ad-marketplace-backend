-- Drop legacy multi-wallet table in favor of users.walletAddress as the single source of truth.
ALTER TABLE "user_wallets" DROP CONSTRAINT IF EXISTS "user_wallets_userId_fkey";
DROP TABLE IF EXISTS "user_wallets";
