-- Stage 10, крок 10i.1, M9b (docs/plan/stage-10-real-world-history.md, §0.13, §6.12, §6.13).
--
-- EXPAND-міграція: лише додає (таблиця, enum, nullable колонки) й ПОСЛАБЛЮЄ один CHECK. Жоден наявний
-- рядок `Copy`/`Loan`/`LoanEvent`/`ExternalBorrower` не читається й не змінюється; старі ручні гостьові
-- позики (10f.3) рядків підтвердження не отримують. Нових значень `LoanEventType` тут не вжито (вони
-- додані окремою міграцією M9a).

-- CreateEnum
CREATE TYPE "GuestLoanConfirmationStatus" AS ENUM ('OPEN', 'DENIED', 'RECEIVED', 'CANCELLED', 'OWNER_RECORDED');

-- AlterTable
ALTER TABLE "ExternalBorrower" ADD COLUMN     "guestEmail" TEXT,
ADD COLUMN     "guestEmailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "guestNickname" TEXT;

-- CreateTable
CREATE TABLE "GuestLoanConfirmation" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "externalBorrowerId" TEXT,
    "status" "GuestLoanConfirmationStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "GuestLoanConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GuestLoanConfirmation_loanId_key" ON "GuestLoanConfirmation"("loanId");

-- CreateIndex
CREATE INDEX "GuestLoanConfirmation_externalBorrowerId_idx" ON "GuestLoanConfirmation"("externalBorrowerId");

-- AddForeignKey
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "GuestLoanConfirmation_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "GuestLoanConfirmation_externalBorrowerId_fkey" FOREIGN KEY ("externalBorrowerId") REFERENCES "ExternalBorrower"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- РУЧНА ПРАВКА нижче (Prisma не виражає CHECK).

-- Підтверджена гостем особа — усе або нічого: нікнейм, email і час перевірки контролю email.
ALTER TABLE "ExternalBorrower" ADD CONSTRAINT "external_borrower_guest_identity_all_or_none"
  CHECK (("guestNickname" IS NULL) = ("guestEmail" IS NULL)
         AND ("guestEmail" IS NULL) = ("guestEmailVerifiedAt" IS NULL));

-- `resolvedAt` заповнений лише для завершених станів (RECEIVED/CANCELLED/OWNER_RECORDED); для OPEN і
-- DENIED — NULL. Обидва боки вираження NOT NULL, тож NULL-пастки CHECK немає.
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_loan_confirmation_resolved_at"
  CHECK (("status" IN ('OPEN'::"GuestLoanConfirmationStatus", 'DENIED'::"GuestLoanConfirmationStatus"))
         = ("resolvedAt" IS NULL));

-- Copy: дозволити `RESERVED` НЕ вдома, але лише коли книжку тримає контакт-гість (`heldByContactId`) —
-- це стан «фізично передано, гість ще не підтвердив» (Loan = PENDING_CONFIRMATION). Обмеження лише
-- ПОСЛАБЛЮЄТЬСЯ для рядків із `heldByContactId IS NOT NULL`, які раніше могли бути лише
-- LENT_OUT/UNAVAILABLE; для будь-якого наявного рядка (жодного RESERVED-поза-домом досі не існує)
-- нове вираження дає той самий результат. `RESERVED` без контакту й поза домом, як і раніше, заборонений.
ALTER TABLE "Copy" DROP CONSTRAINT "copy_away_is_lent_or_unavailable";

ALTER TABLE "Copy" ADD CONSTRAINT "copy_away_is_lent_or_unavailable"
  CHECK ((COALESCE("currentHolderId" = "ownerId", false) AND "heldByContactId" IS NULL)
         OR "status" IN ('LENT_OUT'::"CopyStatus", 'UNAVAILABLE'::"CopyStatus")
         OR ("status" = 'RESERVED'::"CopyStatus" AND "heldByContactId" IS NOT NULL));
