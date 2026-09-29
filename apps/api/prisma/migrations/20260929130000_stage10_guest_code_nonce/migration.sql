-- Stage 10, крок 10i.2 (виправлення рев'ю), M9e (docs/plan/stage-10-real-world-history.md, §6.12, §6.13).
--
-- FORWARD-міграція (M9c/M9d не редагуються): додає до `GuestLoanConfirmation` незалежний ідентифікатор кожної
-- видачі коду. `codeHash` для цього не годиться: за тих самих підтвердження/email/нікнейма однакові шість цифр дають
-- однаковий HMAC, тож пізній збій відправки старішого коду міг би погасити новіший. Нова колонка nullable:
-- жоден наявний рядок не змінюється (усі `codeHash` NULL → `codeNonce` NULL, обмеження істинне).

-- AlterTable
ALTER TABLE "GuestLoanConfirmation" ADD COLUMN     "codeNonce" TEXT;

-- РУЧНА ПРАВКА нижче (Prisma не виражає CHECK).
ALTER TABLE "GuestLoanConfirmation" ADD CONSTRAINT "guest_confirmation_code_nonce"
  CHECK (("codeNonce" IS NULL) = ("codeHash" IS NULL));
