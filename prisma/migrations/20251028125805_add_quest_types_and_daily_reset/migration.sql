/*
  Warnings:

  - Added the required column `questType` to the `Quest` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "QuestType" AS ENUM ('WIN_RACES', 'RUN_RACES', 'BREED_HORSES', 'LEVEL_UP_HORSES', 'EQUIP_ITEMS', 'OPEN_CHESTS', 'SPEND_PHORSE', 'EARN_PHORSE', 'UPGRADE_ITEMS', 'RECYCLE_ITEMS', 'RESTORE_ENERGY', 'CLAIM_REWARDS');

-- AlterTable
ALTER TABLE "Quest" ADD COLUMN     "isDailyQuest" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "questType" "QuestType" NOT NULL;

-- AlterTable
ALTER TABLE "UserQuest" ADD COLUMN     "expiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "UserQuest_expiresAt_idx" ON "UserQuest"("expiresAt");
