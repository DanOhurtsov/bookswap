-- Stage 10, крок 10i.2, M9c (docs/plan/stage-10-real-world-history.md, §6.12, §6.13).
--
-- Нові значення enum `LoanEventType` для публічної відповіді гостя. Окрема міграція, бо PostgreSQL не
-- дозволяє використати нове значення enum у тій самій транзакції, де його додано (той самий принцип,
-- що в M9a). Жодного рядка не читає й не змінює: `LoanEvent` цих типів до цього кроку не існує.
ALTER TYPE "LoanEventType" ADD VALUE 'GUEST_LOAN_RECEIVED';
ALTER TYPE "LoanEventType" ADD VALUE 'GUEST_LOAN_DENIED';
