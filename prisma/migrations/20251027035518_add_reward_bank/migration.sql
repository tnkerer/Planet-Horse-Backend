-- CreateTable
CREATE TABLE "RewardBank" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "available" DECIMAL(36,18) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RewardBank_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RewardBank_token_key" ON "RewardBank"("token");
