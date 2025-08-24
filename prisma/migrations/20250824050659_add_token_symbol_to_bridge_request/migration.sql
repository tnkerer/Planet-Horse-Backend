/*
  Warnings:

  - You are about to drop the column `tokenAddress` on the `BridgeRequest` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "BridgeRequest" DROP COLUMN "tokenAddress",
ADD COLUMN     "tokenSymbol" TEXT;

-- CreateIndex
CREATE INDEX "BridgeRequest_tokenSymbol_idx" ON "BridgeRequest"("tokenSymbol");
