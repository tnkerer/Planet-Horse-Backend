-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "growthPotential" DOUBLE PRECISION,
ADD COLUMN     "legacy" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RaceHistory" ADD COLUMN     "items" TEXT[];
