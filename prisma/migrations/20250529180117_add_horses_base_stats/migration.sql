/*
  Warnings:

  - Added the required column `basePower` to the `Horse` table without a default value. This is not possible if the table is not empty.
  - Added the required column `baseSpeed` to the `Horse` table without a default value. This is not possible if the table is not empty.
  - Added the required column `baseSprint` to the `Horse` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "basePower" INTEGER NOT NULL,
ADD COLUMN     "baseSpeed" INTEGER NOT NULL,
ADD COLUMN     "baseSprint" INTEGER NOT NULL,
ALTER COLUMN "lastRace" DROP NOT NULL;
