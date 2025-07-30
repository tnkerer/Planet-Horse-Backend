/*
  Warnings:

  - A unique constraint covering the columns `[refCode]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "refCode" TEXT,
ADD COLUMN     "referee" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_refCode_key" ON "User"("refCode");
