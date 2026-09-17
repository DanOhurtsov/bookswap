# Rollback runbook — Stage 8f-1 library import schema

Стосується однієї міграції: `20260917120000_library_import` — additive. Вона створює enum-и
`LibraryImportStatus`, `LibraryImportRowStatus`, таблиці `LibraryImport`, `LibraryImportRow`, їхні
індекси, зовнішні ключі (`User → LibraryImport → LibraryImportRow`, `ON DELETE CASCADE`) і
CHECK-обмеження. Наявні таблиці й дані міграція не змінює.

Золоте правило з [catalog-correction-migration-rollback.md](./catalog-correction-migration-rollback.md)
діє і тут: застосований `migration.sql` не редагується й не видаляється, а `prisma migrate reset` не є
способом «скасувати». Відкат — це НОВА forward-міграція.

## Автоматизований доказ

- `apps/api/test/db/library-import-migration.db-spec.ts` — на одноразовій scratch-базі застосовує всі
  попередні міграції, заповнює синтетичні User/Friendship/Author/Work/WorkAuthor/Translation/Edition/
  Copy/Loan/WishlistItem/ProductEvent/CatalogRevision, накочує цю міграцію й перевіряє, що кожен
  наявний рядок лишився незмінним.
- `apps/api/test/db/global-setup.ts` на кожному `pnpm test:db` застосовує всю історію до чистої бази.

## Коли відкат безпечний

Лише доки жоден застосунок не пише в ці таблиці, тобто до деплою 8f-2 (HTTP preview/draft
endpoints). У 8f-1 споживачів немає: repository не підключений до жодного Nest-модуля.

Після деплою 8f-2 видалення таблиць знищує чернетки користувачів (разом із payload рядків).
Доменні дані (`Work`/`Translation`/`Edition`/`Copy`) воно не зачіпає, бо чернетка ніколи не є
доменним записом. Однак застосунок 8f-2+ без цих таблиць падатиме на кожному preview — спершу
відкотити застосунок, потім схему.

## Відкат схеми (нова forward-міграція)

```sql
DROP TABLE "LibraryImportRow";
DROP TABLE "LibraryImport";
DROP TYPE "LibraryImportRowStatus";
DROP TYPE "LibraryImportStatus";
```

Порядок важливий: спершу таблиця з FK на `LibraryImport`, потім сама `LibraryImport`, потім enum-и,
які вже ніхто не використовує. Разом із цією міграцією з `apps/api/prisma/schema.prisma` прибираються
моделі `LibraryImport`, `LibraryImportRow`, обидва enum-и й поле `User.libraryImports`; інакше
наступний `prisma migrate dev` знову згенерує ті самі об'єкти.

Перевірка після застосування на копії production-like бази:

```sql
SELECT to_regclass('"LibraryImport"'), to_regclass('"LibraryImportRow"');  -- обидва NULL
SELECT typname FROM pg_type WHERE typname IN ('LibraryImportStatus', 'LibraryImportRowStatus');  -- 0 рядків
```
