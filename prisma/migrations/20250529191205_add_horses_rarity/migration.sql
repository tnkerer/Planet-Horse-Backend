/*
  Warnings:

  - Added the required column `rarity` to the `Horse` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "rarity" TEXT NOT NULL;
