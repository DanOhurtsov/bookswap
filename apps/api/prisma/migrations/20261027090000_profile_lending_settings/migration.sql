-- BS-148, підетап D (docs/plan/bs-148-profile-design.md): налаштування позичання.
--
-- Лише нові колонки зі сталими типовими значеннями: PostgreSQL додає їх без переписування таблиці, а попередня
-- збірка, що працює під час розгортання, їх не знає й не чіпає. Наявні рядки отримують типові значення:
-- друзі друзів закриті, пауз немає, терміну за замовчуванням немає, нагадування власнику ввімкнені.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "defaultLoanTermDays" INTEGER,
ADD COLUMN "friendsOfFriendsAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "loanRequestsPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "ownerDueReminders" BOOLEAN NOT NULL DEFAULT true;

-- Ті самі значення, що `LOAN_TERM_OPTIONS` у packages/shared.
ALTER TABLE "User" ADD CONSTRAINT "user_default_loan_term_days"
  CHECK ("defaultLoanTermDays" IS NULL OR "defaultLoanTermDays" IN (14, 21, 30));
