-- CreateEnum
CREATE TYPE "TraitTier" AS ENUM ('COMMON', 'RARE', 'MYTHIC');

-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "traitSlotsUnlocked" INTEGER NOT NULL DEFAULT 2;

-- CreateTable
CREATE TABLE "TraitCatalog" (
    "id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "TraitCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HorseTrait" (
    "id" TEXT NOT NULL,
    "horseId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "traitId" INTEGER NOT NULL,
    "tier" "TraitTier" NOT NULL DEFAULT 'COMMON',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HorseTrait_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TraitCatalog_name_key" ON "TraitCatalog"("name");

-- CreateIndex
CREATE INDEX "HorseTrait_horseId_idx" ON "HorseTrait"("horseId");

-- CreateIndex
CREATE INDEX "HorseTrait_traitId_idx" ON "HorseTrait"("traitId");

-- CreateIndex
CREATE UNIQUE INDEX "HorseTrait_horseId_slot_key" ON "HorseTrait"("horseId", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "HorseTrait_horseId_traitId_key" ON "HorseTrait"("horseId", "traitId");

-- AddForeignKey
ALTER TABLE "HorseTrait" ADD CONSTRAINT "HorseTrait_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HorseTrait" ADD CONSTRAINT "HorseTrait_traitId_fkey" FOREIGN KEY ("traitId") REFERENCES "TraitCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
