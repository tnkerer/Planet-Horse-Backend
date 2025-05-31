/*
  Warnings:

  - A unique constraint covering the columns `[ownerId,name]` on the table `Item` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Item_ownerId_name_key" ON "Item"("ownerId", "name");
