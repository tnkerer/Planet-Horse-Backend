/*
  Warnings:

  - You are about to drop the column `logIndex` on the `Deposit` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[txHash]` on the table `Deposit` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Deposit_txHash_logIndex_key";

-- AlterTable
ALTER TABLE "Deposit" DROP COLUMN "logIndex";

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txHash_key" ON "Deposit"("txHash");
