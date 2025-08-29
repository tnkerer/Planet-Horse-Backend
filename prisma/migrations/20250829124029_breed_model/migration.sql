-- CreateTable
CREATE TABLE "Breed" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "parents" INTEGER[],
    "started" TIMESTAMP(3),
    "finalized" BOOLEAN NOT NULL,

    CONSTRAINT "Breed_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Breed" ADD CONSTRAINT "Breed_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
