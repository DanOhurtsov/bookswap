-- Stage 10, крок 10i.2, M9d (docs/plan/stage-10-real-world-history.md, §6.12, §6.13).
--
-- EXPAND-міграція: лише додає nullable/DEFAULT-колонки до `GuestLoanConfirmation` (посилання, виклик
-- перевірки email, доказ) і CHECK-обмеження на них. Жоден наявний рядок не читається й не змінюється:
-- усі нові колонки NULL (лічильники — 0), тож кожне нове обмеження для наявних рядків істинне.
-- Сирі токен/код/email/нікнейм у БД не зберігаються — лише геші/HMAC.

-- AlterTable
ALTER TABLE "GuestLoanConfirmation" ADD COLUMN     "challengeMac" TEXT,
ADD COLUMN     "codeAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeExpiresAt" TIMESTAMP(3),
ADD COLUMN     "codeFailedTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeHash" TEXT,
ADD COLUMN     "codeSentCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codeWindowStartedAt" TIMESTAMP(3),
ADD COLUMN     "linkExpiresAt" TIMESTAMP(3),
ADD COLUMN     "linkIssuedAt" TIMESTAMP(3),
ADD COLUMN     "linkTokenHash" TEXT,
ADD COLUMN     "proofExpiresAt" TIMESTAMP(3),
ADD COLUMN     "proofHash" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "GuestLoanConfirmation_linkTokenHash_key" ON "GuestLoanConfirmation"("linkTokenHash");

-- РУЧНА ПРАВКА нижче (Prisma не виражає CHECK).

-- Посилання: геш, час видачі й строк — усе або нічого; строк = рівно 7 діб від видачі (Q24); посилання
-- можливе лише поки запит чекає відповіді (OPEN). Усі вирази — обидва боки NOT NULL, NULL-пастки немає.
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_link_all_or_none"
  CHECK (("linkTokenHash" IS NULL) = ("linkIssuedAt" IS NULL)
         AND ("linkIssuedAt" IS NULL) = ("linkExpiresAt" IS NULL));

ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_link_ttl"
  CHECK ("linkIssuedAt" IS NULL OR "linkExpiresAt" = "linkIssuedAt" + INTERVAL '7 days');

ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_link_only_open"
  CHECK ("linkTokenHash" IS NULL OR "status" = 'OPEN'::"GuestLoanConfirmationStatus");

-- Код: геш і строк — разом; код і доказ одночасно не існують; обидва потребують виклику (challengeMac),
-- а виклик без коду чи доказу не лишається.
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_code_all_or_none"
  CHECK (("codeHash" IS NULL) = ("codeExpiresAt" IS NULL));

ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_proof_all_or_none"
  CHECK (("proofHash" IS NULL) = ("proofExpiresAt" IS NULL)
         AND ("proofHash" IS NULL) = ("verifiedAt" IS NULL));

ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_code_xor_proof"
  CHECK ("codeHash" IS NULL OR "proofHash" IS NULL);

ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_challenge_consistent"
  CHECK (("challengeMac" IS NOT NULL) = ("codeHash" IS NOT NULL OR "proofHash" IS NOT NULL));

-- Виклик і доказ існують лише в межах чинного посилання.
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_challenge_needs_link"
  CHECK ("challengeMac" IS NULL OR "linkTokenHash" IS NOT NULL);

-- Лічильники не від'ємні.
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_counters_non_negative"
  CHECK ("codeAttempts" >= 0 AND "codeFailedTotal" >= 0 AND "codeSentCount" >= 0);
