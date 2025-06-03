-- CreateEnum
CREATE TYPE "Status" AS ENUM ('SLEEP', 'IDLE', 'BRUISED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAW', 'ITEM');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('FAILED', 'PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "Sex" AS ENUM ('MALE', 'FEMALE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),
    "phorse" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "medals" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nonce" (
    "id" SERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Nonce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Horse" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sex" "Sex" NOT NULL,
    "status" "Status" NOT NULL,
    "rarity" TEXT NOT NULL,
    "exp" INTEGER NOT NULL,
    "upgradable" BOOLEAN NOT NULL,
    "level" INTEGER NOT NULL,
    "basePower" INTEGER NOT NULL,
    "currentPower" INTEGER NOT NULL,
    "baseSprint" INTEGER NOT NULL,
    "currentSprint" INTEGER NOT NULL,
    "baseSpeed" INTEGER NOT NULL,
    "currentSpeed" INTEGER NOT NULL,
    "currentEnergy" INTEGER NOT NULL,
    "maxEnergy" INTEGER NOT NULL,
    "lastRace" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "Horse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "horseId" TEXT,
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "breakable" BOOLEAN NOT NULL,
    "uses" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "txId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chest" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "chestType" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "Chest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_wallet_key" ON "User"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "Nonce_nonce_key" ON "Nonce"("nonce");

-- CreateIndex
CREATE UNIQUE INDEX "Horse_tokenId_key" ON "Horse"("tokenId");

-- CreateIndex
CREATE INDEX "Horse_ownerId_idx" ON "Horse"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "Chest_ownerId_chestType_key" ON "Chest"("ownerId", "chestType");

-- AddForeignKey
ALTER TABLE "Horse" ADD CONSTRAINT "Horse_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chest" ADD CONSTRAINT "Chest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
