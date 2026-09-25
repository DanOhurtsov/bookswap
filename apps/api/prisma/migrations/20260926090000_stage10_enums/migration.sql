-- Stage 10, крок 10a, M1 (docs/plan/stage-10-real-world-history.md, §6.1, §6.13).
--
-- Лише enum-и, і навмисно ОКРЕМО від M2: у PostgreSQL значення, додане через
-- `ALTER TYPE … ADD VALUE`, не можна використати в тій самій транзакції (зокрема в
-- CHECK чи індексі), тож усе, що на нього посилається, живе в наступній міграції.
--
-- Нічого з цього поки не використовується кодом: нові значення `LoanStatus`
-- з'являться в даних лише з кроку 10e. `NotificationType` тут НЕ розширюється —
-- нові типи сповіщень додає крок 10e разом із їхнім використанням.

-- CreateEnum
CREATE TYPE "BorrowerKind" AS ENUM ('REGISTERED', 'GUEST');

-- CreateEnum
CREATE TYPE "LoanOrigin" AS ENUM ('REQUESTED', 'RECORDED_EXISTING', 'RECORDED_GUEST');

-- CreateEnum
CREATE TYPE "LoanEventType" AS ENUM ('RECORD_PROPOSED', 'RECORD_AMENDED', 'RECORD_CONFIRMED', 'RECORD_DECLINED', 'RECORD_WITHDRAWN', 'GUEST_LOAN_RECORDED', 'LOAN_RETURNED', 'LOAN_LOST', 'RECOVERED');

-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'PENDING_CONFIRMATION';
ALTER TYPE "LoanStatus" ADD VALUE 'DECLINED';
