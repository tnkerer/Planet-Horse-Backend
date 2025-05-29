/*
  Warnings:

  - A unique constraint covering the columns `[ownerId,chestType]` on the table `Chest` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Chest_ownerId_chestType_key" ON "Chest"("ownerId", "chestType");
