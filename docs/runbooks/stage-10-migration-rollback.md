# Runbook — Етап 10, кроки 10a, 10c, 10d і 10e: розширення схеми, RESTRICT, однократний recover та ексклюзивний запис (розгортання й відкат лише вперед)

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
  міграцією не відновлюються — лише з backup. Зміну `Loan → Copy` на `RESTRICT` виконано в кроці 10c
  (M3, див. розділ нижче).
- Прив’язка контакту до акаунта (D5), retention (D3), audit-події й індекс `one_active_loan_per_copy`
  з `PENDING_CONFIRMATION` — у наступних міграціях (M5–M6), не в 10a.

## Крок 10c: M3 `20260926090200_stage10_delete_restrict` — `Loan_copyId_fkey` `CASCADE → RESTRICT`

Одна міграція, що змінює лише правило зовнішнього ключа `Loan.copyId → Copy.id`:
`ON DELETE CASCADE` → `ON DELETE RESTRICT`. **Жоден наявний рядок `Copy` чи `Loan` не змінюється й не
видаляється.** Міграція торкається тільки майбутньої поведінки: `DELETE FROM "Copy"` тепер падає, доки в
примірника є хоч один `Loan` будь-якого статусу. Примірники, вже втрачені старим каскадом, не
відновлюються (лише з backup).

**Порядок розгортання.** M3 і код 10c (`removeCopy`, archive/restore) розгортаються **разом**: старий код на
схемі з `RESTRICT` дав би 500 замість доменної відповіді на `DELETE /me/library/:id`, коли в примірника
є історія. Тобто: backup → `pnpm db:deploy` → одразу деплой API і web 10c.

**Автоматизований доказ.**

- `apps/api/test/db/stage10-delete-restrict-migration.db-spec.ts` — на scratch-базі з наповненими
  `Copy`/`Loan` (включно з `RETURNED`, `REJECTED`, `HANDED_OVER`, `LOST`) застосовує M3 і перевіряє: рядки
  байт-в-байт ті самі; правило FK стало `RESTRICT`; `DELETE` примірника з будь-яким `Loan` відхиляється;
  примірник без `Loan` видаляється (DEL4, DEL1).
- `apps/api/test/db/referential-actions.db-spec.ts` — інвертований тест колишнього каскаду (DEL4).
- `apps/api/test/library-archive.e2e-spec.ts` — API: delete/archive/restore, гонка delete ∥ запит (DEL1–DEL3, A1–A4).
- `prisma migrate diff … --exit-code` — схема й міграції еквівалентні (MIG4).

**Перевірка після розгортання.**

```sql
SELECT confdeltype FROM pg_constraint WHERE conname = 'Loan_copyId_fkey';   -- 'r' (RESTRICT)
-- Кількості Copy/Loan збігаються зі знімком «до».
```

**Відкат: лише вперед.** Повернути `CASCADE` можна лише новою міграцією, і це **не рекомендовано**: воно знову
дозволило б стирати історію позичань видаленням примірника. Безпечна відповідь на проблему — виправлення
коду вперед. Відкат коду 10c на реліз до 10c при схемі з `RESTRICT` небезпечний з тієї самої причини
(старий `DELETE` дасть 500 для примірників з історією); якщо він неминучий — лише разом з новою міграцією-відкатом
FK та усвідомленням, що каскад знову стирає історію.

**Дані архіву.** Поле `Copy.archivedAt` з'явилося в M2; 10c лише починає його заповнювати. Архівний примірник
відновлюється дією «Відновити» (`POST /me/library/:copyId/restore`); окремого audit-запису про
archive/restore немає (рішення Product Owner щодо Q11).

## Крок 10d: M4 `20260926100000_stage10_recovered_unique` — однократний `recover`

Одна міграція, один оператор:

```sql
CREATE UNIQUE INDEX "one_recovery_per_loan" ON "LoanEvent" ("loanId") WHERE "type" = 'RECOVERED';
```

Частковий індекс: не більше однієї події `RECOVERED` на позику; події інших типів (`LOAN_LOST`, майбутні `RECORD_*`)
він не обмежує. Це однократність ефекту, а не «повторна успішна відповідь»: другий `recover` тієї самої позики — це
`409 LOAN_ALREADY_RECOVERED` (перевірка під `FOR UPDATE` на `Copy`; індекс — остання лінія оборони для гонки, яку та
перевірка не бачить). Індекс поза `schema.prisma` (Prisma не виражає часткових індексів), як
`one_active_loan_per_copy`; `prisma migrate diff` його не вимагає.

**Що міграція НЕ робить.** Не читає й не змінює жодного `Copy`/`Loan`; не створює жодної події (`LoanEvent` до 10d
ніхто не писав — таблиця порожня); не переписує старі позики. Старі `LOST`-позики лишаються без `LOAN_LOST` і
відновлюються (`recover`) одразу: подія `RECOVERED` для них створюється лише в момент дії, а дату втрати ніхто не
вигадує.

**Порядок розгортання.** backup → `pnpm db:deploy` (M4 застосовується миттєво: таблиця порожня, `CREATE INDEX` без
`CONCURRENTLY` безпечний) → деплой API і web 10d. Код 10d **потребує** M4: без індексу однократність тримається лише
перевіркою під локом. Старий код (до 10d) з M4 сумісний: він `LoanEvent` не пише.

**Rollout-нюанси.**

- Після деплою новий успішний `mark_lost` пише `LOAN_LOST` (нічого не змінює для читачів: `LoanEvent` не віддається
  ніде, крім `Loan.recovery` для сторін позики).
- `LoanEvent → Loan` — `RESTRICT`: позику з подіями не видалити; це очікувано (історія не стирається).
- Змінилися контракти `/loans`: у `Loan` з'явилися `recovery` і `copy.isArchived`; у `PATCH /loans/:id` — дія
  `recover` та поле `effectiveAt`. Веб 10d і API 10d розгортаються разом: старий web із новим API продовжує працювати
  (нові поля ігноруються zod-схемою клієнта), але новий web зі старим API впав би на парсингу `Loan` (немає `recovery`).

**Автоматизований доказ.**

- `apps/api/test/db/stage10-recovered-unique-migration.db-spec.ts` — на scratch-базі з наповненими `Copy`/`Loan` (у т. ч.
  дві `LOST`-позики без подій): M4 не змінює жодного рядка, не створює подій (REC5); індекс унікальний і частковий;
  друга `RECOVERED` тієї самої позики → `23505` на `one_recovery_per_loan` (REC2, окремо від API); `LOAN_LOST` і
  `RECOVERED` інших позик індекс не зачіпає.
- `apps/api/test/loans-recovery.e2e-spec.ts` — REC1–REC5, A4, приватність, межа request-flow, гонка й `INSERT`-порушення
  індексу (409 замість 500, `Copy` відкочено).
- `apps/api/test/loans-recovery-rollback.e2e-spec.ts` — збій запису `LoanEvent` відкочує зміну `Copy` (і `mark_lost`).
- `prisma migrate diff … --exit-code` — схема й міграції еквівалентні (MIG4).

**Перевірка після розгортання.**

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'one_recovery_per_loan';   -- UNIQUE … WHERE ("type" = 'RECOVERED')
SELECT count(*) FROM "LoanEvent";                                            -- 0 одразу після M4 (до першого mark_lost/recover)
-- Кількості Copy/Loan збігаються зі знімком «до».
-- Інваріант: не більше однієї RECOVERED на позику:
SELECT "loanId" FROM "LoanEvent" WHERE type = 'RECOVERED' GROUP BY "loanId" HAVING count(*) > 1;   -- 0 рядків
```

**Відкат: лише вперед.** Видалити індекс можна лише новою міграцією, і це **не рекомендовано**: `recover` знову
міг би дати кілька подій на позику при гонці. Відкат коду 10d безпечний для даних (події не читаються старим
кодом), але новий `LoanEvent`/`Copy` після `recover` залишаться: примірник уже `AVAILABLE`, а `Loan` — `LOST`.

## Крок 10e: M5a `20260926110000_stage10_record_notification_types` і M5 `20260926110100_stage10_exclusive_pending`

Дві міграції запису наявної позики між друзями ([§6.13 плану](../plan/stage-10-real-world-history.md), M5a/M5):

- **M5a** — `ALTER TYPE "NotificationType" ADD VALUE` ×5: `LOAN_RECORD_PROPOSED`, `LOAN_RECORD_CONFIRMED`,
  `LOAN_RECORD_DECLINED`, `LOAN_RECORD_WITHDRAWN`, `LOAN_RECORD_AMENDED`. Окрема міграція, бо нове значення enum не
  можна використати в тій самій транзакції.
- **M5** — `one_active_loan_per_copy` перестворено з предикатом `status IN ('APPROVED', 'HANDED_OVER',
  'PENDING_CONFIRMATION')` (`DROP INDEX` + `CREATE UNIQUE INDEX`). Предикат лише **розширюється**: значення
  `PENDING_CONFIRMATION` існує зі схеми 10a, але жоден наявний рядок його не має, тож індекс будується без порушень.

**Жоден наявний `Copy`/`Loan`/`LoanEvent`/`Notification` не читається й не змінюється.** Індекс будується коротким
блокуючим `CREATE` (для поточних обсягів достатньо; `CONCURRENTLY` — лише за потреби на великій таблиці, окремою
міграцією).

**Порядок розгортання.** Backup → `pnpm db:deploy` (M5a, потім M5) → деплой API і web 10e. Міграції безпечні для
попереднього коду до появи рядків `PENDING_CONFIRMATION`: старий код їх не створює. Після появи будь-якого запису
(`origin = RECORDED_EXISTING`) **відкочувати код на реліз до 10e небезпечно** (старий код не знає статусів запису, а `/loans`
їх не показував би, тоді як примірник лишається `RESERVED`).

**Автоматизований доказ.**

- `apps/api/test/db/stage10-exclusive-pending-migration.db-spec.ts` — на scratch-базі з наповненими `Copy`/`Loan`/`Notification`
  застосовує M5a і M5 та перевіряє: усі наявні рядки байт-в-байт ті самі (MIG1); нові значення `NotificationType` існують і
  придатні для запису; індекс частковий, унікальний і включає `PENDING_CONFIRMATION` (MIG3); два записи на один примірник, а також
  запис + `APPROVED`/`HANDED_OVER` порушують індекс (C1); `REQUESTED`, `DECLINED`, `CANCELLED` і термінальні статуси
  співіснують із записом.
- `apps/api/test/db/schema-objects.db-spec.ts` — вигляд індексу; `apps/api/src/common/enum-parity.spec.ts` — паритет
  Prisma ↔ `packages/shared`; `prisma migrate diff … --exit-code` — «No difference detected» (MIG4).

**Перевірка після розгортання.**

```sql
SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_loan_per_copy';
-- WHERE ... status = ANY (ARRAY['APPROVED', 'HANDED_OVER', 'PENDING_CONFIRMATION'])
SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
 WHERE t.typname = 'NotificationType' AND enumlabel LIKE 'LOAN_RECORD_%';   -- 5 рядків
SELECT count(*) FROM "Loan" WHERE status IN ('PENDING_CONFIRMATION','DECLINED');  -- 0 до першого запису
```

Вручну: запис → підтвердження (`HANDED_OVER`, `LENT_OUT`), запис → відмова/відкликання (примірник знову `AVAILABLE`),
звичайний потік «запит → погодити → передано → повернено».

**Відкат: лише вперед.** Значення enum не видаляються. Індекс можна повернути до двох статусів НОВОЮ міграцією лише за
`SELECT count(*) FROM "Loan" WHERE status = 'PENDING_CONFIRMATION'` = `0` (інакше змінений предикат порушив би дані або дозволив
би дубль). Функцію запису вимикають деплоєм без ендпоінта `POST /loans/recorded` та UI, а наявні запити довиконують сторони.

**Відомі межі 10e.** Непідтверджений запис не скасовується автоматично (Q6); нагадування власнику через 30 днів (10e-r)
**лише заплановано** і в цій міграції відсутнє. Правка дат після підтвердження заборонена (Q12).

## Крок 10i.1: M9a `20260929090000_stage10_guest_confirmation_enum` і M9b `20260929090100_stage10_guest_confirmation_expand`

Лише синтетичні дані (D2 відкритий; реальні email і нікнейми гостей заборонені в будь-якому середовищі). Публічних
маршрутів гостя, посилань, email-коду й UI цей крок не додає — лише owner-only API `/api/v1/guest-loan-confirmations`
за `GuestLoansEnabledGuard`.

**M9a** — `ALTER TYPE "LoanEventType" ADD VALUE` ×3 (`GUEST_CONFIRMATION_REQUESTED`, `GUEST_HANDOVER_CANCELLED`,
`GUEST_LOAN_OWNER_RECORDED`). Окрема міграція: PostgreSQL не дозволяє вжити нове значення enum у тій самій
транзакції (той самий принцип, що M1/M5a/M8a). Жодного рядка не читає й не змінює.

**M9b** — expand (лише додає й послаблює один CHECK):

- новий enum `GuestLoanConfirmationStatus` (`OPEN`, `DENIED`, `RECEIVED`, `CANCELLED`, `OWNER_RECORDED`) і таблиця
  `GuestLoanConfirmation` (`loanId` UNIQUE, `externalBorrowerId` → `ExternalBorrower` `ON DELETE SET NULL`, `Loan` —
  `RESTRICT`); CHECK `guest_loan_confirmation_resolved_at` (`resolvedAt IS NULL` ⇔ статус `OPEN`/`DENIED`);
- `ExternalBorrower.guestNickname/guestEmail/guestEmailVerifiedAt` (nullable); CHECK
  `external_borrower_guest_identity_all_or_none` (усі три `NULL` або всі не-`NULL`);
- `copy_away_is_lent_or_unavailable` перестворено: додається **єдиний** виняток — `RESERVED` поза домом дозволений,
  лише коли книжку тримає контакт (`heldByContactId IS NOT NULL`). Це стан «фізично передано, гість ще не
  підтвердив». Для наявних рядків вираз рівнозначний старому (жодного `RESERVED` поза домом досі не існувало).

**Що міграції НЕ роблять.** Не читають і не змінюють жодного `Copy`/`Loan`/`LoanEvent`; не створюють рядків
підтвердження — старі ручні гостьові позики (10f.3) їх **не** отримують і лишаються «зі слів власника». Наявні
`ExternalBorrower` лише отримують три `NULL`-колонки.

**Порядок розгортання.** backup → `pnpm db:deploy` (M9a, потім M9b; таблиця нова, індекси будуються миттєво) → деплой
API. Код 10i.1 **потребує** M9b: без послабленого CHECK створення запиту (`Copy = RESERVED` у контакта) впаде.
Старий код (до 10i.1) з M9a/M9b сумісний: він нових колонок/таблиці не читає.

**Відкат: лише вперед** (feature-flag `GUEST_LOANS_ENABLED=false` + виправлення вперед). Після появи рядків
`GuestLoanConfirmation`, `Loan = PENDING_CONFIRMATION` з `borrowerKind = GUEST` і `Copy = RESERVED` у контакта
відкат коду на реліз до 10i.1 **небезпечний**: старий код цих станів не знає. Повернення старого CHECK міграцією
впало б на таких `Copy`. Значення enum видалити не можна.

**Наслідок для видалення контакту.** `RESERVED` у контакта не переживає його видалення (`SET NULL` дав би `RESERVED`
без тримача — CHECK це гучно відхиляє). У застосунку це недосяжно: `PENDING_CONFIRMATION` входить до
`EXCLUSIVE_LOAN_STATUS` і блокує ручний `DELETE` та CLI-чистку контакту (`EXTERNAL_BORROWER_HAS_ACTIVE_LOAN`); після
скасування передачі `Copy` уже `AVAILABLE` вдома.

**Порядок локів** (нові транзакції узгоджено з ручним `DELETE` і CLI-чисткою): `ExternalBorrower → Copy → Loan →
GuestLoanConfirmation`.

**Автоматизований доказ.**

- `apps/api/test/db/stage10-guest-confirmation-migration.db-spec.ts` — на scratch-базі з наповненими даними: M9a+M9b не
  змінюють жодного `Copy`/`Loan`/`LoanEvent`; рядків підтвердження немає; нові значення enum працюють; CHECK-и `Copy`,
  `ExternalBorrower`, `GuestLoanConfirmation`; UNIQUE `loanId`; FK `SET NULL`/`RESTRICT`.
- `apps/api/test/db/schema-objects.db-spec.ts`, `loan-constraints.db-spec.ts` — форма CHECK-ів і `RESERVED` у контакта.
- `apps/api/test/guest-loan-confirmations.e2e-spec.ts` — owner API, права, старий шлях 10f.3, конкурентні `REQUESTED`,
  `DELETE`/CLI після скасування, гонки create/cancel/record/delete, відсутність витоку `guestNickname`/`guestEmail`.
- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` — схема й міграції
  еквівалентні.

## Крок 10i.2: M9c `20260929120000_stage10_guest_response_enum` і M9d `20260929120100_stage10_guest_response_expand`

Лише синтетичні дані (D2 відкритий). Крок додає backend видачі посилання власником і публічної відповіді гостя без
акаунта (`POST /guest-loan-confirmations/:id/link`, `/api/v1/guest-loan-responses/*`); web UI й сповіщення (10i.3) не
додає.

**M9c** — `ALTER TYPE "LoanEventType" ADD VALUE` ×2 (`GUEST_LOAN_RECEIVED`, `GUEST_LOAN_DENIED`). Окрема міграція
(нове значення enum не можна вжити в тій самій транзакції; той самий принцип, що M9a). Жодного рядка не читає й не змінює.

**M9d** — expand: лише додає до `GuestLoanConfirmation` колонки посилання (`linkTokenHash` UNIQUE, `linkIssuedAt`,
`linkExpiresAt`), виклику перевірки email (`challengeMac`, `codeHash`, `codeExpiresAt`, `codeAttempts`,
`codeFailedTotal`, `codeSentCount`, `codeWindowStartedAt`) і доказу (`proofHash`, `proofExpiresAt`, `verifiedAt`) та
дев'ять CHECK-ів `guest_confirmation_*`: посилання — усе або нічого; строк — **рівно 7 діб** від видачі; посилання лише
для статусу `OPEN`; код і доказ — усе або нічого й **не одночасно**; виклик існує лише разом із кодом чи доказом і лише в межах
чинного посилання; лічильники ≥ 0. Усі нові колонки — `NULL` (лічильники — `0`): жоден наявний рядок `Copy`/`Loan`/`LoanEvent`/
`ExternalBorrower`/`GuestLoanConfirmation` не змінюється, старі ручні позики 10f.3 рядків підтвердження й посилань не отримують.
У БД **не зберігаються** сирі токен, код, email гостя чи нікнейм — лише SHA-256 (токен, доказ) і HMAC-SHA-256 (виклик, код);
підтверджені нікнейм/email потрапляють лише в `ExternalBorrower.guestNickname/guestEmail` і лише після доведеної відповіді.

**Порядок розгортання.** backup → `pnpm db:deploy` (M9c, потім M9d) → деплой API. Код 10i.2 **потребує** M9d (колонки
й CHECK-и); старий код (10i.1) з M9c/M9d сумісний: нових колонок не читає. Публічні маршрути лишаються за `GUEST_LOANS_ENABLED`
(`GuestLoansEnabledGuard` першим, до БД).

**Ключ HMAC.** Виклик і код рахуються з `INVITE_EMAIL_HMAC_SECRET` (окремі префікси доменів; нового env-ключа немає). Зміна
ключа або рестарт без ключа (поза production ключ випадковий) робить **чинні коди й докази недійсними** — гість просить новий код;
відкритий запит, посилання (геш токена не залежить від ключа) і `Loan`/`Copy` не страждають.

**Відкат: лише вперед** (`GUEST_LOANS_ENABLED=false` + виправлення вперед). Значення enum видалити не можна; колонки M9d
можна залишити (nullable/`DEFAULT`). Вимкнення функції гасить публічні маршрути, але не чинні посилання в БД (вони
безпечні: без маршруту відповісти неможливо; рішення власника чи нова видача їх обнулюють).

**Автоматизований доказ.**

- `apps/api/test/db/stage10-guest-response-migration.db-spec.ts` — на scratch-базі з наповненими даними (відкритий і
  заперечений запити, ручна позика 10f.3): M9c+M9d не змінюють жодного наявного рядка, нові значення enum працюють, кожен CHECK
  (7 діб, `OPEN`-лише, all-or-none, код XOR доказ, узгодженість виклику, лічильники), UNIQUE геш токена.
- `apps/api/test/db/schema-objects.db-spec.ts` — перелік CHECK-ів `GuestLoanConfirmation`.
- `apps/api/test/guest-loan-responses.e2e-spec.ts`, `guest-loan-responses-provider.e2e-spec.ts`, `external-borrowers-off.e2e-spec.ts`
  — поведінка (див. [план §9.3](../plan/stage-10-real-world-history.md#93-invite-10g-гостьове-підтвердження-10i-та-відкладений-d5)).
- `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` — схема й міграції еквівалентні.

### Доповнення 10i.2: M9e `20260929130000_stage10_guest_code_nonce` (виправлення рев'ю)

Forward-міграція (M9c/M9d не редагуються): `GuestLoanConfirmation.codeNonce` (nullable) і CHECK `guest_confirmation_code_nonce`
(`codeNonce IS NULL` ⇔ `codeHash IS NULL`). Nonce — випадковий 128-бітний ідентифікатор **кожної видачі коду**; за ним `requestCode`
гасить код після збою відправки. `codeHash` для цього не годиться: за тих самих підтвердження/email/нікнейма однакові шість цифр дають
однаковий HMAC. Усі наявні рядки: `codeHash` і `codeNonce` — `NULL` (обмеження істинне), жоден рядок не змінюється. Порядок
розгортання й відкат — як для M9d (лише вперед; nullable-колонку можна залишити). Код 10i.2 після цього виправлення **потребує** M9e.
Доказ: `stage10-guest-response-migration.db-spec.ts` (M9e на наповненій БД, CHECK), `schema-objects.db-spec.ts`, e2e
«рев'ю 10i.2» (збій першої відправки не гасить код із тими самими шістьма цифрами).
