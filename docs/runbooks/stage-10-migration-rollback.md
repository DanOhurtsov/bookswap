# Runbook — Етап 10, крок 10a: розширення схеми (розгортання й відкат лише вперед)

Стосується двох міграцій кроку 10a
([execution plan](../plan/stage-10-real-world-history.md), §6.13, M1–M2):

- `20260926090000_stage10_enums` (M1) — enum-и `BorrowerKind`, `LoanOrigin`, `LoanEventType` і два нові
  значення `LoanStatus`: `PENDING_CONFIRMATION`, `DECLINED`;
- `20260926090100_stage10_expand` (M2) — таблиці `ExternalBorrower`, `LoanEvent`; колонки
  `Loan.borrowerKind/borrowerContactId/origin/createdAt`, `Copy.archivedAt/heldByContactId`;
  `Loan.borrowerId`, `Loan.requestedAt`, `Copy.currentHolderId` стали nullable; переписані CHECK-и
  `Copy` і два нові CHECK-и `Loan`.

Це **expand**-міграції: вони лише додають і послаблюють. Жоден рядок `Copy`/`Loan` не видаляється
і не змінюється (єдиний UPDATE — заповнення нової колонки `Loan.createdAt = requestedAt`). Крок 10a
**не змінює поведінки** застосунку: гостьових записів, архіву, записаних позик і нових статусів у даних
немає — їх створять лише кроки 10c–10f.

> **D2 — відкритий release blocker.** Гостьова функція заблокована, а таблиця `ExternalBorrower` у
> 10a лишається порожньою. Реальні персональні дані гостя заборонені в **будь-якому** середовищі
> (див. [§7 плану](../plan/stage-10-real-world-history.md#7-d2--відкритий-release-blocker)).
> Розгортання цього runbook-у D2 не знімає.

Золоте правило з [catalog-correction-migration-rollback.md](./catalog-correction-migration-rollback.md)
діє й тут: застосований `migration.sql` не редагується і не видаляється, `prisma migrate reset` не є
способом «скасувати». Відкат — це НОВА forward-міграція.

## Автоматизований доказ

- `apps/api/test/db/stage10-expand-migration.db-spec.ts` — на одноразовій scratch-базі застосовує всі
  попередні міграції, наповнює `Copy` (усі статуси, вдома й у позичальника) та `Loan` (усі сім
  наявних статусів), накочує M1 і M2 та перевіряє: наявні рядки збігаються байт-в-байт по старих
  колонках (MIG1); переписані CHECK-и дають ті самі відповіді для всіх не гостьових станів і
  закривають NULL-пастку (MIG2); код попереднього релізу, що вставляє рядки лише зі старими
  колонками, працює далі (MIG6).
- `apps/api/test/db/schema-objects.db-spec.ts` — перелік і вигляд CHECK-ів.
- `apps/api/src/common/enum-parity.spec.ts` — паритет Prisma ↔ `packages/shared` (MIG5).
- `pnpm --filter @bookswap/api exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
  на БД з накоченими міграціями — «No difference detected» (MIG4).
- `apps/api/test/stage10-readers.e2e-spec.ts` — читачі (бібліотека, позики, історія, щоденна задача)
  витримують стан «книжка в гостя».

## Перед розгортанням

1. **Backup.** Повний дамп БД (`pg_dump -Fc`), файл збережено поза сервером БД. Без нього не починати.
2. **Знімок кількостей** (для порівняння після):

   ```sql
   SELECT 'Copy' AS t, count(*) FROM "Copy"
   UNION ALL SELECT 'Loan', count(*) FROM "Loan"
   UNION ALL SELECT 'Loan HANDED_OVER', count(*) FROM "Loan" WHERE status = 'HANDED_OVER'
   UNION ALL SELECT 'Loan LOST', count(*) FROM "Loan" WHERE status = 'LOST';
   ```

3. **Наявні дані задовольняють нові CHECK-и.** Обидва запити мусять повернути `0`:

   ```sql
   -- Copy: чи є рядки, що порушують нові CHECK-и (за старою семантикою вони чинні)
   SELECT count(*) FROM "Copy"
   WHERE ("status" = 'AVAILABLE' AND "currentHolderId" <> "ownerId")
      OR ("currentHolderId" <> "ownerId" AND "status" NOT IN ('LENT_OUT','UNAVAILABLE'))
      OR ("status" = 'LENT_OUT' AND "currentHolderId" = "ownerId");
   -- Loan: NULL-позичальник не може існувати до цієї міграції
   SELECT count(*) FROM "Loan" WHERE "borrowerId" IS NULL OR "requestedAt" IS NULL;
   ```

   Ненульовий результат означає, що дані вже були неконсистентні: зупинитися й розібратися **до**
   міграції, а не її «обходити».
4. Переконатися, що `prisma migrate status` не показує розбіжностей історії (жодна раніше
   застосована міграція не змінена).

## Розгортання (порядок)

1. `prisma migrate deploy` (`pnpm db:deploy`) — застосовує M1, потім M2. Це один прохід; M1 навмисно
   окрема міграція, бо нове значення enum не можна використати в тій самій транзакції.
2. Деплой API і web з кроку 10a. Порядок «міграція → код» безпечний: старий код не бачить нових
   колонок, а його INSERT-и працюють завдяки дефолтам (`borrowerKind = REGISTERED`,
   `origin = REQUESTED`, `createdAt = now()`; дефолт `requestedAt = now()` збережено навмисно).
3. Нові функції Етапу 10 (existing loan, archive, recover, guest) у 10a **не вмикаються** — їхніх
   ендпоінтів ще немає.

## Перевірка після розгортання

```sql
-- 1. Кількості збігаються зі знімком «до».
-- 2. Нові об'єкти порожні, наявні рядки — з безпечними дефолтами:
SELECT count(*) FROM "ExternalBorrower";                       -- 0
SELECT count(*) FROM "LoanEvent";                              -- 0
SELECT count(*) FROM "Copy" WHERE "archivedAt" IS NOT NULL OR "heldByContactId" IS NOT NULL;  -- 0
SELECT count(*) FROM "Loan"
 WHERE "borrowerKind" <> 'REGISTERED' OR origin <> 'REQUESTED'
    OR "borrowerContactId" IS NOT NULL OR "borrowerId" IS NULL OR "requestedAt" IS NULL
    OR "createdAt" <> "requestedAt";                           -- 0
-- 3. CHECK-и на місці:
SELECT conname FROM pg_constraint
 WHERE conrelid IN ('"Copy"'::regclass, '"Loan"'::regclass) AND contype = 'c' ORDER BY conname;
-- copy_available_is_home, copy_away_is_lent_or_unavailable, copy_lent_out_is_away, copy_single_holder,
-- loan_borrower_kind_valid, loan_borrower_not_owner, loan_requested_has_request_time
-- 4. Індекс активної позики не змінено (лише APPROVED, HANDED_OVER):
SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_loan_per_copy';
```

Далі — димова перевірка вручну: звичайний потік «запит → погодити → передано → повернено», «Мої
не вдома», історія примірника й твору, «Мої позики».

## Відкат: лише вперед

**Код.** До появи рядків Етапу 10 (їх створюють кроки 10c–10f) відкат застосунку на попередній
реліз безпечний: схема лишається сумісною. Після появи будь-якого рядка з `borrowerId IS NULL`,
`Copy.currentHolderId IS NULL`, `archivedAt IS NOT NULL` або статусами
`PENDING_CONFIRMATION`/`DECLINED` **відкочувати код на реліз до Етапу 10 небезпечно**: старий код
припускає непорожнього позичальника й тримача. У такому разі — вимкнути функцію та виправляти вперед.

**Схема.** Значення enum у PostgreSQL не видаляються (`ALTER TYPE … DROP VALUE` не існує), тож
`PENDING_CONFIRMATION`/`DECLINED` та нові enum-и лишаються — вони нешкідливі, доки їх ніхто не
використовує. Повернути решту можна НОВОЮ міграцією (наприклад `stage10_revert`), і **лише** коли
перевірки нижче дають `0`:

```sql
-- Передумови (кожен запит мусить повернути 0; інакше відкат схеми знищив би дані Етапу 10):
SELECT count(*) FROM "ExternalBorrower";
SELECT count(*) FROM "LoanEvent";
SELECT count(*) FROM "Loan" WHERE "borrowerId" IS NULL OR "requestedAt" IS NULL
   OR "borrowerKind" <> 'REGISTERED' OR origin <> 'REQUESTED'
   OR status IN ('PENDING_CONFIRMATION','DECLINED');
SELECT count(*) FROM "Copy" WHERE "currentHolderId" IS NULL OR "heldByContactId" IS NOT NULL
   OR "archivedAt" IS NOT NULL;
```

```sql
-- Відновлення попередніх CHECK-ів (тіло з міграції 20260816194509_loan_state_machine)
ALTER TABLE "Copy" DROP CONSTRAINT "copy_single_holder";
ALTER TABLE "Copy" DROP CONSTRAINT "copy_available_is_home";
ALTER TABLE "Copy" DROP CONSTRAINT "copy_away_is_lent_or_unavailable";
ALTER TABLE "Copy" DROP CONSTRAINT "copy_lent_out_is_away";
ALTER TABLE "Loan" DROP CONSTRAINT "loan_borrower_kind_valid";
ALTER TABLE "Loan" DROP CONSTRAINT "loan_requested_has_request_time";
ALTER TABLE "Copy" ADD CONSTRAINT "copy_available_is_home"
  CHECK ("status" <> 'AVAILABLE'::"CopyStatus" OR "currentHolderId" = "ownerId");
ALTER TABLE "Copy" ADD CONSTRAINT "copy_away_is_lent_or_unavailable"
  CHECK ("currentHolderId" = "ownerId" OR "status" IN ('LENT_OUT'::"CopyStatus", 'UNAVAILABLE'::"CopyStatus"));
ALTER TABLE "Copy" ADD CONSTRAINT "copy_lent_out_is_away"
  CHECK ("status" <> 'LENT_OUT'::"CopyStatus" OR "currentHolderId" <> "ownerId");

-- Повернення NOT NULL (спрацює лише за нульових передумов вище)
ALTER TABLE "Copy" ALTER COLUMN "currentHolderId" SET NOT NULL;
ALTER TABLE "Loan" ALTER COLUMN "borrowerId" SET NOT NULL;
ALTER TABLE "Loan" ALTER COLUMN "requestedAt" SET NOT NULL;

-- Прибирання нових об'єктів
DROP TABLE "LoanEvent";
ALTER TABLE "Copy" DROP COLUMN "heldByContactId", DROP COLUMN "archivedAt";
ALTER TABLE "Loan" DROP COLUMN "borrowerContactId", DROP COLUMN "borrowerKind",
  DROP COLUMN "origin", DROP COLUMN "createdAt";
DROP TABLE "ExternalBorrower";
DROP TYPE "LoanEventType";
DROP TYPE "LoanOrigin";
DROP TYPE "BorrowerKind";
```

Разом із такою міграцією з `apps/api/prisma/schema.prisma` прибираються відповідні моделі, поля й
enum-и, а генерований клієнт і `packages/shared` синхронізуються; інакше наступний
`prisma migrate dev` знову згенерує ті самі об'єкти. Значення `LoanStatus` (`PENDING_CONFIRMATION`,
`DECLINED`) у схемі й у `packages/shared` лишаються, бо PostgreSQL їх не видалить.

## Відновлення з backup

Backup, зроблений **до** M1–M2, після відновлення потребує повторного `prisma migrate deploy`.
Backup, зроблений після появи рядків Етапу 10, містить їхні дані: після кроку 10h (retention D3)
відновлення повертає стерті alias, тож після кожного restore чистку треба запускати негайно
(пункт для runbook-у Етапу 11).

## Відомі межі

- Примірники з історією, **уже видалені** попередньою каскадною поведінкою до Етапу 10, цією
  міграцією не відновлюються — лише з backup. Зміна `Loan → Copy` на `RESTRICT` відбудеться в кроці
  10c разом із новою логікою видалення (окремий runbook-розділ до того кроку).
- Прив’язка контакту до акаунта (D5), retention (D3), audit-події й індекс `one_active_loan_per_copy`
  з `PENDING_CONFIRMATION` — у наступних міграціях (M4–M6), не в 10a.
