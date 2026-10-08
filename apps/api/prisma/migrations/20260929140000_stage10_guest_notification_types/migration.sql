-- Stage 10, крок 10i.3, M9f (docs/plan/stage-10-real-world-history.md, §6.12, §6.13).
--
-- Нові значення enum `NotificationType` для сповіщення власника про відповідь гостя («Отримав книжку» /
-- «Не отримував»). Окрема міграція, бо PostgreSQL не дозволяє використати нове значення enum у тій самій
-- транзакції, де його додано (той самий принцип, що в M5a і M9c). Жодного рядка не читає й не змінює:
-- сповіщень цих типів до цього кроку не існує. Технічне рішення для рев'ю: типи доставляються лише in-app
-- (`IN_APP`), без EMAIL/TELEGRAM — це забезпечує код, а не схема БД.
ALTER TYPE "NotificationType" ADD VALUE 'GUEST_LOAN_RECEIVED';
ALTER TYPE "NotificationType" ADD VALUE 'GUEST_LOAN_DENIED';
