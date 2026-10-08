-- Швидке додавання книжок, етап C1 (docs/plan/fast-book-add.md, §4; реліз R2): EXPAND.
--
-- Лише послаблює й додає: `Work.origLang` і `Edition.format` стають nullable, з'являються `Edition.textKind`
-- (nullable) і `Edition.lang`. Жоден наявний рядок не змінюється. `DEFAULT PAPERBACK` для `format` ЛИШАЄТЬСЯ:
-- попередні релізи вставляють видання без формату й покладаються на нього.
--
-- Backfill і `textKind NOT NULL` — окрема міграція C2 (R3), після того як усі інстанси працюють на R2.
-- CreateEnum
CREATE TYPE "EditionTextKind" AS ENUM ('ORIGINAL', 'TRANSLATION', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Edition" ADD COLUMN     "lang" TEXT,
ADD COLUMN     "textKind" "EditionTextKind",
ALTER COLUMN "format" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Work" ALTER COLUMN "origLang" DROP NOT NULL;
