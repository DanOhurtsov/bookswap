-- Stage 10, крок 10i.1, M9a (docs/plan/stage-10-real-world-history.md, §0.13, §6.12, §6.13).
--
-- Нові значення enum `LoanEventType` для запиту гостьового підтвердження. Окрема міграція, бо PostgreSQL
-- не дозволяє використати нове значення enum у тій самій транзакції, де його додано (той самий принцип,
-- що в M1/M5a/M8a). Жодного рядка не читає й не змінює: `LoanEvent` цих типів до цього кроку не існує.
ALTER TYPE "LoanEventType" ADD VALUE 'GUEST_CONFIRMATION_REQUESTED';
ALTER TYPE "LoanEventType" ADD VALUE 'GUEST_HANDOVER_CANCELLED';
ALTER TYPE "LoanEventType" ADD VALUE 'GUEST_LOAN_OWNER_RECORDED';
