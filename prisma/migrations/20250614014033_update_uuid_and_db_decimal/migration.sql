/*
  Warnings:

  - You are about to drop the column `txHash` on the `Deposit` table. All the data in the column will be lost.
  - You are about to alter the column `amount` on the `Deposit` table. The data in that column could be lost. The data in that column will be cast from `Decimal(78,0)` to `Decimal(78,18)`.

*/
-- DropIndex
DROP INDEX "Deposit_txHash_key";

-- AlterTable
ALTER TABLE "Deposit" DROP COLUMN "txHash",
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(78,18);
