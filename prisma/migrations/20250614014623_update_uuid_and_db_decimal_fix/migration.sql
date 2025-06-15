/*
  Warnings:

  - A unique constraint covering the columns `[txHash]` on the table `Deposit` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `txHash` to the `Deposit` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "txHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txHash_key" ON "Deposit"("txHash");
