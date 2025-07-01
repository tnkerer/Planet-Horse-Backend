-- CreateTable
CREATE TABLE "RaceHistory" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "phorseEarned" DOUBLE PRECISION NOT NULL,
    "xpEarned" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "horseId" TEXT NOT NULL,

    CONSTRAINT "RaceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RaceHistory_horseId_idx" ON "RaceHistory"("horseId");

-- AddForeignKey
ALTER TABLE "RaceHistory" ADD CONSTRAINT "RaceHistory_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
