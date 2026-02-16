-- Backfill onboarding completion timestamp for users that already have at least one active role.
UPDATE "users"
SET "onboardingCompletedAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP)
WHERE ("isAdvertiser" = true OR "isChannelOwner" = true)
  AND "onboardingCompletedAt" IS NULL;
