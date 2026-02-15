-- CreateTable
CREATE TABLE "user_telegram_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CODE',
    "phone_number" TEXT NOT NULL,
    "session_encrypted" TEXT NOT NULL,
    "auth_state_encrypted" TEXT,
    "last_authorized_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_telegram_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_telegram_sessions_user_id_key" ON "user_telegram_sessions"("user_id");

-- CreateIndex
CREATE INDEX "user_telegram_sessions_status_idx" ON "user_telegram_sessions"("status");

-- AddForeignKey
ALTER TABLE "user_telegram_sessions" ADD CONSTRAINT "user_telegram_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
