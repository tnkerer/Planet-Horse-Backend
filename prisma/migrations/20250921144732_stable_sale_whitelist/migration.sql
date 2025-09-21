-- CreateTable
CREATE TABLE "StableSale" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gtd" BOOLEAN NOT NULL DEFAULT false,
    "fcfs" BOOLEAN NOT NULL DEFAULT false,
    "discount" INTEGER NOT NULL DEFAULT 0,
    "gtdUsed" BOOLEAN NOT NULL DEFAULT false,
    "fcfsUsed" BOOLEAN NOT NULL DEFAULT false,
    "discountList" TEXT[],

    CONSTRAINT "StableSale_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StableSale_userId_key" ON "StableSale"("userId");

-- AddForeignKey
ALTER TABLE "StableSale" ADD CONSTRAINT "StableSale_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
