-- Швидке додавання книжок, етап C2 (docs/plan/fast-book-add.md, §4; реліз R3): CONTRACT.
--
-- Виконується лише коли ВСІ інстанси API працюють на R2: код R2 записує `textKind` і `lang` явно, а код
-- R0/R1 (який їх не пише) після цього вставити видання вже не зможе — `textKind` стає обов'язковим.
--
-- 1. Backfill легасі-рядків (`textKind IS NULL`) відтворює РІВНО те, що попередній код обчислював на льоту:
--    зв'язок з перекладом — переклад із мовою перекладу; без нього — оригінал із мовою оригіналу твору.
--    Він ідемпотентний (кожен крок зачіпає лише ще не заповнене) і не чіпає рядків, які R2 уже записав.
-- 2. `textKind SET NOT NULL`.
-- 3. CHECK I1: видання з прив'язаним перекладом — це переклад.
--
-- Жоден ID, зв'язок, позика чи запис історії не змінюється: лише заповнюються нові колонки.

-- Тип тексту: зв'язок з перекладом ⇒ переклад, інакше оригінал (стара семантика).
UPDATE "Edition"
SET "textKind" = CASE WHEN "translationId" IS NULL THEN 'ORIGINAL'::"EditionTextKind"
                      ELSE 'TRANSLATION'::"EditionTextKind" END
WHERE "textKind" IS NULL;

-- Мова видання з перекладом — мова перекладу (стара обчислена мова).
UPDATE "Edition" AS e
SET "lang" = t."lang"
FROM "Translation" AS t
WHERE e."translationId" = t."id"
  AND e."lang" IS NULL;

-- Мова видання-оригіналу — мова оригіналу твору (де вона відома: до R4 завжди).
UPDATE "Edition" AS e
SET "lang" = w."origLang"
FROM "Work" AS w
WHERE e."workId" = w."id"
  AND e."translationId" IS NULL
  AND e."textKind" = 'ORIGINAL'
  AND e."lang" IS NULL
  AND w."origLang" IS NOT NULL;

-- AlterTable
ALTER TABLE "Edition" ALTER COLUMN "textKind" SET NOT NULL;

-- I1: з прив'язаним перекладом — лише TRANSLATION.
ALTER TABLE "Edition"
  ADD CONSTRAINT "edition_translation_implies_translation_kind"
  CHECK ("translationId" IS NULL OR "textKind" = 'TRANSLATION');
