-- CreateTable
CREATE TABLE "HorseMintRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "txId" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "HorseMintRequest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "HorseMintRequest" ADD CONSTRAINT "HorseMintRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
