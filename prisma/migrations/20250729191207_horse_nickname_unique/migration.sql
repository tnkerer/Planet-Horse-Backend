/*
  Warnings:

  - A unique constraint covering the columns `[nickname]` on the table `Horse` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "Horse_nickname_key" ON "Horse"("nickname");
