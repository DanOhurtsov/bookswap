-- Швидке додавання книжок, етап D (docs/plan/fast-book-add.md, §5.3; реліз R4): зовнішні посилання на видання.
--
-- Додає таблицю `EditionExternalReference` і знімає `DEFAULT PAPERBACK` з `Edition.format`: з цього релізу формат
-- без відомостей від джерела лишається невідомим. Наявні рядки не змінюються. Код R2/R3 таблицю ігнорує й сам
-- записує формат явно, тож rollback на R3/R2 безпечний.

-- CreateEnum
CREATE TYPE "ExternalBookSource" AS ENUM ('OPEN_LIBRARY', 'GOOGLE_BOOKS', 'ISBNDB');

-- AlterTable
ALTER TABLE "Edition" ALTER COLUMN "format" DROP DEFAULT;

-- CreateTable
CREATE TABLE "EditionExternalReference" (
    "id" TEXT NOT NULL,
    "source" "ExternalBookSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "editionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditionExternalReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditionExternalReference_editionId_idx" ON "EditionExternalReference"("editionId");

-- CreateIndex
CREATE UNIQUE INDEX "EditionExternalReference_source_externalId_key" ON "EditionExternalReference"("source", "externalId");

-- AddForeignKey
ALTER TABLE "EditionExternalReference" ADD CONSTRAINT "EditionExternalReference_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
