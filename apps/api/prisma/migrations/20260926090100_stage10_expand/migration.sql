-- Stage 10, крок 10a, M2 (docs/plan/stage-10-real-world-history.md, §6.1, §6.13).
--
-- EXPAND-міграція: лише додає й послаблює. Жоден рядок `Copy`/`Loan` не видаляється,
-- жоден історичний факт не змінюється; єдиний UPDATE — backfill НОВОЇ колонки
-- `Loan.createdAt`. Поведінка застосунку не змінюється: гостьових записів, архіву й
-- нових статусів у даних ще немає (API з'являється в 10c–10f).
--
-- Сумісність зі старим кодом під час rollout (міграція → деплой): старий код не знає
-- нових колонок, а його INSERT-и працюють завдяки дефолтам (`borrowerKind = REGISTERED`,
-- `origin = REQUESTED`, `createdAt = now()`, `requestedAt = now()` — дефолт `requestedAt`
-- збережено навмисно, див. T2).
--
-- Усі CHECK-и й FK нижче виконуються як одна транзакція (один multi-statement запит),
-- тож вікна без інваріантів між DROP старих і ADD нових немає.

-- AlterTable
ALTER TABLE "Copy" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "heldByContactId" TEXT,
ALTER COLUMN "currentHolderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "borrowerContactId" TEXT,
ADD COLUMN     "borrowerKind" "BorrowerKind" NOT NULL DEFAULT 'REGISTERED',
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "origin" "LoanOrigin" NOT NULL DEFAULT 'REQUESTED',
ALTER COLUMN "borrowerId" DROP NOT NULL,
ALTER COLUMN "requestedAt" DROP NOT NULL;

-- Backfill нової колонки: для наявних позик «коли запис створено» = «коли просили».
-- Для всіх наявних рядків `requestedAt` NOT NULL, тож COALESCE лише підстраховує.
UPDATE "Loan" SET "createdAt" = COALESCE("requestedAt", "createdAt");

-- CreateTable
CREATE TABLE "ExternalBorrower" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "ownerInformedAt" TIMESTAMP(3),
    "retainUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalBorrower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanEvent" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" "LoanEventType" NOT NULL,
    "actorId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveAt" TIMESTAMP(3),
    "payload" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LoanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalBorrower_ownerId_idx" ON "ExternalBorrower"("ownerId");

-- CreateIndex
CREATE INDEX "ExternalBorrower_retainUntil_idx" ON "ExternalBorrower"("retainUntil");

-- CreateIndex
CREATE INDEX "LoanEvent_loanId_occurredAt_idx" ON "LoanEvent"("loanId", "occurredAt");

-- CreateIndex
CREATE INDEX "Copy_heldByContactId_idx" ON "Copy"("heldByContactId");

-- CreateIndex
CREATE INDEX "Loan_borrowerContactId_idx" ON "Loan"("borrowerContactId");

-- AddForeignKey
ALTER TABLE "Copy" ADD CONSTRAINT "Copy_heldByContactId_fkey" FOREIGN KEY ("heldByContactId") REFERENCES "ExternalBorrower"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_borrowerContactId_fkey" FOREIGN KEY ("borrowerContactId") REFERENCES "ExternalBorrower"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalBorrower" ADD CONSTRAINT "ExternalBorrower_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEvent" ADD CONSTRAINT "LoanEvent_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanEvent" ADD CONSTRAINT "LoanEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- РУЧНА ПРАВКА нижче (Prisma не виражає CHECK).
--
-- Інваріанти §5.3.2 переписано під nullable-тримача (T1-a) БЕЗ послаблення для
-- наявних даних. Введено поняття «вдома»:
--
--   home := COALESCE("currentHolderId" = "ownerId", false) AND "heldByContactId" IS NULL
--
-- COALESCE обов'язковий: при `currentHolderId IS NULL` вираз `= "ownerId"` дає NULL, а
-- CHECK трактує NULL як «пройшло» — це та сама NULL-пастка, яку описано в міграції
-- `loan_state_machine`. Для будь-якого рядка з `heldByContactId IS NULL` і
-- `currentHolderId IS NOT NULL` (тобто для всіх наявних) нові вирази РІВНОСИЛЬНІ старим.
-- Нове лише те, що книга «не вдома», коли тримач — контакт або невідомий (NULL/NULL).
ALTER TABLE "Copy" DROP CONSTRAINT "copy_available_is_home";
ALTER TABLE "Copy" DROP CONSTRAINT "copy_away_is_lent_or_unavailable";
ALTER TABLE "Copy" DROP CONSTRAINT "copy_lent_out_is_away";

-- 1. Вільна книжка завжди вдома.
ALTER TABLE "Copy" ADD CONSTRAINT "copy_available_is_home"
  CHECK ("status" <> 'AVAILABLE'::"CopyStatus"
         OR (COALESCE("currentHolderId" = "ownerId", false) AND "heldByContactId" IS NULL));

-- 2. Не вдома — лише LENT_OUT або UNAVAILABLE (RESERVED тут немає: «домовлено» = «ще вдома»).
ALTER TABLE "Copy" ADD CONSTRAINT "copy_away_is_lent_or_unavailable"
  CHECK ((COALESCE("currentHolderId" = "ownerId", false) AND "heldByContactId" IS NULL)
         OR "status" IN ('LENT_OUT'::"CopyStatus", 'UNAVAILABLE'::"CopyStatus"));

-- 3. LENT_OUT означає, що книжка фізично не вдома.
ALTER TABLE "Copy" ADD CONSTRAINT "copy_lent_out_is_away"
  CHECK ("status" <> 'LENT_OUT'::"CopyStatus"
         OR NOT (COALESCE("currentHolderId" = "ownerId", false) AND "heldByContactId" IS NULL));

-- 4. Новий: тримач — або користувач, або контакт, не обидва одразу.
ALTER TABLE "Copy" ADD CONSTRAINT "copy_single_holder"
  CHECK ("currentHolderId" IS NULL OR "heldByContactId" IS NULL);

-- Loan: зареєстрований позичальник ⇔ `borrowerId`; гість ⇔ немає `borrowerId`
-- (контакт NULL лише після D3-чистки). Усі наявні рядки — REGISTERED з `borrowerId`.
ALTER TABLE "Loan" ADD CONSTRAINT "loan_borrower_kind_valid"
  CHECK (("borrowerKind" = 'REGISTERED'::"BorrowerKind"
            AND "borrowerId" IS NOT NULL AND "borrowerContactId" IS NULL)
         OR ("borrowerKind" = 'GUEST'::"BorrowerKind" AND "borrowerId" IS NULL));

-- Loan: без запиту (`requestedAt IS NULL`) можуть бути лише записані власником позики.
ALTER TABLE "Loan" ADD CONSTRAINT "loan_requested_has_request_time"
  CHECK ("origin" <> 'REQUESTED'::"LoanOrigin" OR "requestedAt" IS NOT NULL);

-- `loan_borrower_not_owner` (`borrowerId <> ownerId`) лишається без змін: для NULL-позичальника
-- (гість) він дає NULL, тобто не заважає, а для зареєстрованого діє як раніше.
