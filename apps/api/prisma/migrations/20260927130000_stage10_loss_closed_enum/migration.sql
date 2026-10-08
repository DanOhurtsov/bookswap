-- Stage 10, крок 10f.3, M8a (docs/plan/stage-10-real-world-history.md, §6.11.1, T7b-1, §6.13).
--
-- Нове значення enum `LoanEventType`. Окрема міграція, бо PostgreSQL не дозволяє використати нове
-- значення enum у тій самій транзакції, де його додано (той самий принцип, що вже застосований у
-- M1/M5a). Ніякого рядка не читає й не змінює: `LoanEvent` до цього кроку значення `LOSS_CLOSED`
-- ніколи не мав.
ALTER TYPE "LoanEventType" ADD VALUE 'LOSS_CLOSED';
