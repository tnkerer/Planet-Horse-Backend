/*
  Warnings:

  - A unique constraint covering the columns `[txHash,logIndex]` on the table `Deposit` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Deposit_txHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txHash_logIndex_key" ON "Deposit"("txHash", "logIndex");
