-- CreateTable
CREATE TABLE "ItemBridgeRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "request" "Request" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "txId" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "ItemBridgeRequest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ItemBridgeRequest" ADD CONSTRAINT "ItemBridgeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
