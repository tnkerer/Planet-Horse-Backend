/*
  Warnings:

  - Added the required column `lastRace` to the `Horse` table without a default value. This is not possible if the table is not empty.
  - Added the required column `level` to the `Horse` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phorse` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Item" DROP CONSTRAINT "Item_horseId_fkey";

-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastRace" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "level" INTEGER NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Item" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "updatedAt" TIMESTAMP(3),
ALTER COLUMN "horseId" DROP NOT NULL,
ALTER COLUMN "uses" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "phorse" DOUBLE PRECISION NOT NULL;

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_horseId_fkey" FOREIGN KEY ("horseId") REFERENCES "Horse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
