-- Stage 10, крок 10e, M5a (docs/plan/stage-10-real-world-history.md, §6.1, §6.13).
--
-- Лише enum, і навмисно ОКРЕМО від M5: значення, додане через `ALTER TYPE … ADD VALUE`, не можна
-- використати в тій самій транзакції. Нові типи сповіщень життєвого циклу запису наявної позики.
-- Жоден наявний рядок не читається й не змінюється.

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_RECORD_PROPOSED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_RECORD_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_RECORD_DECLINED';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_RECORD_WITHDRAWN';
ALTER TYPE "NotificationType" ADD VALUE 'LOAN_RECORD_AMENDED';
