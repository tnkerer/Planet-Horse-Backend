-- CreateTable
CREATE TABLE "Chest" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "chestType" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "Chest_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Chest" ADD CONSTRAINT "Chest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
