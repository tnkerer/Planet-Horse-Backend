/*
  Warnings:

  - You are about to drop the column `lastRace` on the `Horse` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Horse" DROP COLUMN "lastRace",
ADD COLUMN     "lastEnergy" TIMESTAMP(3);
