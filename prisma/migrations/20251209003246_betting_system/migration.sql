-- AlterTable
ALTER TABLE "PvpRace" ADD COLUMN     "bettingPoolWron" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "totalBetWron" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PvpBet" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "raceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "horseId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PvpBet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PvpBet_raceId_idx" ON "PvpBet"("raceId");

-- CreateIndex
CREATE INDEX "PvpBet_horseId_idx" ON "PvpBet"("horseId");

-- CreateIndex
CREATE INDEX "PvpBet_userId_idx" ON "PvpBet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PvpBet_raceId_userId_horseId_key" ON "PvpBet"("raceId", "userId", "horseId");

-- AddForeignKey
ALTER TABLE "PvpBet" ADD CONSTRAINT "PvpBet_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "PvpRace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpBet" ADD CONSTRAINT "PvpBet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PvpBet" ADD CONSTRAINT "PvpBet_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
