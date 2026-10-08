-- Stage 10, крок 10j.1, M7 (docs/plan/stage-10-real-world-history.md, §6.15 T11/T16, §0.15).
--
-- EXPAND-міграція: лише додає enum `ReadingStatus` і порожню таблицю `WorkReadingStatus`. Жоден наявний рядок
-- не читається й не змінюється. Backfill відсутній: «Прочитано» не виводиться з `Loan` (R-3).
-- CreateEnum
CREATE TYPE "ReadingStatus" AS ENUM ('NOT_READ', 'READING', 'READ');

-- CreateTable
CREATE TABLE "WorkReadingStatus" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "status" "ReadingStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkReadingStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkReadingStatus_userId_updatedAt_id_idx" ON "WorkReadingStatus"("userId", "updatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WorkReadingStatus_userId_workId_key" ON "WorkReadingStatus"("userId", "workId");

-- AddForeignKey
ALTER TABLE "WorkReadingStatus" ADD CONSTRAINT "WorkReadingStatus_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkReadingStatus" ADD CONSTRAINT "WorkReadingStatus_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
