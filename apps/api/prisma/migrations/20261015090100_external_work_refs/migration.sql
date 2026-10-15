-- BS-114: підтверджені джерелом посилання на зовнішній ТВІР (docs/plan/fast-book-add.md, §13).
--
-- Лише expand: нова таблиця `WorkExternalReference`; наявні таблиці й рядки не змінюються. Посилання на твір живе
-- окремо від `EditionExternalReference`, щоб ID зовнішнього твору ніколи не видавався за ID видання.
-- Код попереднього релізу таблицю ігнорує, тож rollback коду безпечний.

-- CreateTable
CREATE TABLE "WorkExternalReference" (
    "id" TEXT NOT NULL,
    "source" "ExternalBookSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "workId" TEXT NOT NULL,
    "editionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkExternalReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkExternalReference_workId_idx" ON "WorkExternalReference"("workId");

-- CreateIndex
CREATE INDEX "WorkExternalReference_editionId_idx" ON "WorkExternalReference"("editionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkExternalReference_source_externalId_key" ON "WorkExternalReference"("source", "externalId");

-- AddForeignKey
ALTER TABLE "WorkExternalReference" ADD CONSTRAINT "WorkExternalReference_workId_fkey" FOREIGN KEY ("workId") REFERENCES "Work"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkExternalReference" ADD CONSTRAINT "WorkExternalReference_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
