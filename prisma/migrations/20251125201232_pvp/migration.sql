-- CreateEnum
CREATE TYPE "PvpRaceStatus" AS ENUM ('OPEN', 'RUNNING', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "mmr" INTEGER NOT NULL DEFAULT 1000;

-- CreateTable
CREATE TABLE "PvpRace" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "registrationOpensAt" TIMESTAMP(3) NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "maxMmr" INTEGER,
    "maxParticipants" INTEGER,
    "allowedRarities" TEXT[],
    "wronEntryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "phorseEntryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "wronPayoutPercent" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "pctFirst" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "pctSecond" DOUBLE PRECISION NOT NULL DEFAULT 0.35,
    "pctThird" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "status" "PvpRaceStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "PvpRace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PvpRaceEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raceId" TEXT NOT NULL,
    "horseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mmrAtEntry" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PvpRaceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PvpHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raceId" TEXT NOT NULL,
    "horseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "mmrBefore" INTEGER NOT NULL,
    "mmrAfter" INTEGER NOT NULL,
    "wronPrize" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "phorseBurned" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PvpHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PvpRaceEntry_raceId_idx" ON "PvpRaceEntry"("raceId");

-- CreateIndex
CREATE INDEX "PvpRaceEntry_horseId_idx" ON "PvpRaceEntry"("horseId");

-- CreateIndex
CREATE INDEX "PvpRaceEntry_userId_idx" ON "PvpRaceEntry"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PvpRaceEntry_raceId_userId_key" ON "PvpRaceEntry"("raceId", "userId");

-- CreateIndex
CREATE INDEX "PvpHistory_raceId_idx" ON "PvpHistory"("raceId");

-- CreateIndex
CREATE INDEX "PvpHistory_horseId_idx" ON "PvpHistory"("horseId");

-- CreateIndex
CREATE INDEX "PvpHistory_userId_idx" ON "PvpHistory"("userId");

-- CreateIndex
CREATE INDEX "PvpHistory_position_idx" ON "PvpHistory"("position");

-- AddForeignKey
ALTER TABLE "PvpRaceEntry" ADD CONSTRAINT "PvpRaceEntry_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "PvpRace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpRaceEntry" ADD CONSTRAINT "PvpRaceEntry_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpRaceEntry" ADD CONSTRAINT "PvpRaceEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpHistory" ADD CONSTRAINT "PvpHistory_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "PvpRace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpHistory" ADD CONSTRAINT "PvpHistory_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpHistory" ADD CONSTRAINT "PvpHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
