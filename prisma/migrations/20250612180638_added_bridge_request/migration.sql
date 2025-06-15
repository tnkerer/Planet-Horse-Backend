-- CreateEnum
CREATE TYPE "Request" AS ENUM ('DEPOSIT', 'WITHDRAW', 'BURN', 'MINT');

-- CreateTable
CREATE TABLE "BridgeRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "request" "Request" NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "transactionId" TEXT NOT NULL,

    CONSTRAINT "BridgeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BridgeRequest_transactionId_key" ON "BridgeRequest"("transactionId");

-- AddForeignKey
ALTER TABLE "BridgeRequest" ADD CONSTRAINT "BridgeRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeRequest" ADD CONSTRAINT "BridgeRequest_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
