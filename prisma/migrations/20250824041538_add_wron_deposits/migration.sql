/*
  Warnings:

  - A unique constraint covering the columns `[txHash,tokenAddress]` on the table `Deposit` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[txId,type,tokenAddress]` on the table `Transaction` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `tokenAddress` to the `Deposit` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tokenSymbol` to the `Deposit` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Deposit_txHash_key";

-- AlterTable
ALTER TABLE "BridgeRequest" ADD COLUMN     "tokenAddress" TEXT;

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN     "tokenAddress" TEXT NOT NULL,
ADD COLUMN     "tokenSymbol" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "tokenAddress" TEXT,
ADD COLUMN     "tokenSymbol" TEXT;

-- CreateIndex
CREATE INDEX "Deposit_tokenAddress_idx" ON "Deposit"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Deposit_txHash_tokenAddress_key" ON "Deposit"("txHash", "tokenAddress");

-- CreateIndex
CREATE INDEX "Transaction_tokenAddress_idx" ON "Transaction"("tokenAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_txId_type_tokenAddress_key" ON "Transaction"("txId", "type", "tokenAddress");
