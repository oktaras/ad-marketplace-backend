-- CreateTable
CREATE TABLE "mtproto_sessions" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CODE',
    "phone_number" TEXT NOT NULL,
    "session_encrypted" TEXT NOT NULL,
    "auth_state_encrypted" TEXT,
    "last_authorized_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mtproto_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mtproto_sessions_channel_id_key" ON "mtproto_sessions"("channel_id");

-- CreateIndex
CREATE INDEX "mtproto_sessions_owner_id_idx" ON "mtproto_sessions"("owner_id");

-- CreateIndex
CREATE INDEX "mtproto_sessions_status_idx" ON "mtproto_sessions"("status");

-- AddForeignKey
ALTER TABLE "mtproto_sessions" ADD CONSTRAINT "mtproto_sessions_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mtproto_sessions" ADD CONSTRAINT "mtproto_sessions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
