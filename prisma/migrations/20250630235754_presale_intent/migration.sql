-- CreateEnum
CREATE TYPE "IntentStage" AS ENUM ('STARTED', 'PROCESSING', 'DONE');

-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "intentId" TEXT;

-- CreateTable
CREATE TABLE "PresaleIntent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" INTEGER NOT NULL,
    "status" "IntentStage" NOT NULL,

    CONSTRAINT "PresaleIntent_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Horse" ADD CONSTRAINT "Horse_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PresaleIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
