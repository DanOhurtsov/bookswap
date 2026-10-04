-- Швидке додавання книжок, етап A (docs/plan/fast-book-add.md, §5.2): серверна ідемпотентність.
--
-- EXPAND-міграція: лише додає enum і порожню таблицю `LibraryAddOperation`. Жоден наявний рядок не читається
-- й не змінюється; попередній реліз таблицю ігнорує, тож rollback коду на R0 безпечний.
-- CreateEnum
CREATE TYPE "LibraryAddTargetKind" AS ENUM ('EXISTING_EDITION', 'EXTERNAL_EDITION', 'MANUAL');

-- CreateTable
CREATE TABLE "LibraryAddOperation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "targetKind" "LibraryAddTargetKind" NOT NULL,
    "editionId" TEXT NOT NULL,
    "copyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibraryAddOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibraryAddOperation_copyId_idx" ON "LibraryAddOperation"("copyId");

-- CreateIndex
CREATE INDEX "LibraryAddOperation_targetKind_createdAt_idx" ON "LibraryAddOperation"("targetKind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LibraryAddOperation_userId_operationId_key" ON "LibraryAddOperation"("userId", "operationId");

-- AddForeignKey
ALTER TABLE "LibraryAddOperation" ADD CONSTRAINT "LibraryAddOperation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibraryAddOperation" ADD CONSTRAINT "LibraryAddOperation_copyId_fkey" FOREIGN KEY ("copyId") REFERENCES "Copy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
