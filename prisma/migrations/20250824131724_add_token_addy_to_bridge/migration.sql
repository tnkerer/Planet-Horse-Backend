-- AlterTable
ALTER TABLE "BridgeRequest" ADD COLUMN     "tokenAddress" TEXT;

-- CreateIndex
CREATE INDEX "BridgeRequest_tokenAddress_idx" ON "BridgeRequest"("tokenAddress");
