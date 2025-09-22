-- AlterTable
ALTER TABLE "Horse" ADD COLUMN     "stableid" TEXT;

-- CreateTable
CREATE TABLE "Stable" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "features" TEXT[],
    "level" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "Stable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StableMintRequest" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "tokenId" INTEGER NOT NULL,
    "txId" TEXT,
    "status" "TransactionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "StableMintRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Stable_tokenId_key" ON "Stable"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "Stable_userId_key" ON "Stable"("userId");

-- AddForeignKey
ALTER TABLE "Horse" ADD CONSTRAINT "Horse_stableid_fkey" FOREIGN KEY ("stableid") REFERENCES "Stable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Stable" ADD CONSTRAINT "Stable_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StableMintRequest" ADD CONSTRAINT "StableMintRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
