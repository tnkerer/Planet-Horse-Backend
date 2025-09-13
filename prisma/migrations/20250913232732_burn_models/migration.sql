-- AlterEnum
ALTER TYPE "TransactionType" ADD VALUE 'BURN';

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "tokenId" INTEGER;

-- CreateTable
CREATE TABLE "BurnRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "from" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BurnRequest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BurnRequest" ADD CONSTRAINT "BurnRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
