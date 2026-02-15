/*
  Warnings:

  - You are about to drop the `mtproto_sessions` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "mtproto_sessions" DROP CONSTRAINT "mtproto_sessions_channel_id_fkey";

-- DropForeignKey
ALTER TABLE "mtproto_sessions" DROP CONSTRAINT "mtproto_sessions_owner_id_fkey";

-- DropTable
DROP TABLE "mtproto_sessions";
