/*
  Warnings:

  - A unique constraint covering the columns `[replacedBySessionId]` on the table `Session` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "replacedBySessionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Session_replacedBySessionId_key" ON "Session"("replacedBySessionId");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_replacedBySessionId_fkey" FOREIGN KEY ("replacedBySessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
