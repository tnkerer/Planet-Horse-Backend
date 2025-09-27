/*
  Warnings:

  - Added the required column `upgrading` to the `Stable` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "StableRentCurrency" AS ENUM ('PHORSE', 'WRON', 'OTHER');

-- CreateEnum
CREATE TYPE "LeaseStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('HELD', 'PARTIAL', 'RELEASED', 'REFUNDED');

-- DropIndex
DROP INDEX "Stable_userId_key";

-- AlterTable
ALTER TABLE "Stable" ADD COLUMN     "upgradeStarted" TIMESTAMP(3),
ADD COLUMN     "upgrading" BOOLEAN NOT NULL;

-- CreateTable
CREATE TABLE "StableListing" (
    "id" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "isOpen" BOOLEAN NOT NULL DEFAULT false,
    "listedSlots" INTEGER NOT NULL DEFAULT 0,
    "currency" "StableRentCurrency" NOT NULL,
    "pricePerSlotWk" DECIMAL(78,18) NOT NULL,
    "tokenAddress" TEXT,
    "tokenSymbol" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StableListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StableLease" (
    "id" TEXT NOT NULL,
    "stableId" TEXT NOT NULL,
    "lesseeId" TEXT NOT NULL,
    "slotCount" INTEGER NOT NULL,
    "currency" "StableRentCurrency" NOT NULL,
    "tokenAddress" TEXT,
    "tokenSymbol" TEXT,
    "pricePerSlotWk" DECIMAL(78,18) NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" "LeaseStatus" NOT NULL DEFAULT 'PENDING',
    "escrowAmount" DECIMAL(78,18) NOT NULL,
    "escrowStatus" "EscrowStatus" NOT NULL DEFAULT 'HELD',
    "heldFrom" TIMESTAMP(3) NOT NULL,
    "heldUntil" TIMESTAMP(3) NOT NULL,
    "releasedAmount" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "refundedAmount" DECIMAL(78,18) NOT NULL DEFAULT 0,
    "terminatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StableLease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StableListing_stableId_key" ON "StableListing"("stableId");

-- CreateIndex
CREATE INDEX "StableListing_isOpen_idx" ON "StableListing"("isOpen");

-- CreateIndex
CREATE INDEX "StableListing_currency_idx" ON "StableListing"("currency");

-- CreateIndex
CREATE INDEX "StableListing_tokenAddress_idx" ON "StableListing"("tokenAddress");

-- CreateIndex
CREATE INDEX "StableLease_stableId_idx" ON "StableLease"("stableId");

-- CreateIndex
CREATE INDEX "StableLease_lesseeId_idx" ON "StableLease"("lesseeId");

-- CreateIndex
CREATE INDEX "StableLease_status_endAt_idx" ON "StableLease"("status", "endAt");

-- CreateIndex
CREATE INDEX "Stable_userId_idx" ON "Stable"("userId");

-- AddForeignKey
ALTER TABLE "StableListing" ADD CONSTRAINT "StableListing_stableId_fkey" FOREIGN KEY ("stableId") REFERENCES "Stable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StableLease" ADD CONSTRAINT "StableLease_stableId_fkey" FOREIGN KEY ("stableId") REFERENCES "Stable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StableLease" ADD CONSTRAINT "StableLease_lesseeId_fkey" FOREIGN KEY ("lesseeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
