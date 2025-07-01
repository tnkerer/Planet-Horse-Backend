/*
  Warnings:

  - Added the required column `wallet` to the `PresaleIntent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PresaleIntent" ADD COLUMN     "wallet" TEXT NOT NULL;
