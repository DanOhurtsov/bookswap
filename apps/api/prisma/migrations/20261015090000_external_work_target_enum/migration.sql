-- BS-114: додавання зовнішнього запису ТВОРУ без конкретного видання (docs/plan/fast-book-add.md, §13).
--
-- Нове значення enum `LibraryAddTargetKind`. Окрема міграція, бо PostgreSQL не дозволяє використати нове
-- значення enum у тій самій транзакції, де його додано. Наявних рядків не читає й не змінює.
ALTER TYPE "LibraryAddTargetKind" ADD VALUE 'EXTERNAL_WORK';
