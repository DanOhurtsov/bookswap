# Етап 10 — реальний світ і довіра до історії: execution plan

**Статус:** план; **кроки 10a, 10b і 10c реалізовано** (див. [§8](#8-послідовність-реалізаційних-кроків)), кроки 10d–10j не
розпочато. Q0, Q8, Q10, Q11 і Q13 затверджено Product Owner ([§0.2](#02-рішення-product-owner-отримані-для-кроку-10a)).
Решта Q і всі T-пропозиції, окрім T1-a, лишаються **незатвердженими**.
**Джерело:** [Product Roadmap v2, Етап 10](./roadmap-v2.md#етап-10--реальний-світ-і-довіра-до-історії).
**Гілка реалізації:** `codex/stage-10-real-world-history` (Q0, затверджено PO).
**Gate зі специфікацією:** для розбіжностей із §5 PO дав явне рішення про пріоритет (Q13) —
[§0.2](#02-рішення-product-owner-отримані-для-кроку-10a); `docs/specification.md` при цьому не змінюється.
Розбіжності, **не** перелічені в §5, цим рішенням не покриваються.
**Не закриває:** Етап 8 і beta release gate; **D2 лишається відкритим release blocker**
([§7](#7-d2--відкритий-release-blocker)), а технічний запобіжник його не знімає. Android Chrome QA Етапу 8 — **NOT RUN**
([runbook](../runbooks/stage-8-manual-qa.md)); цей план його не виконує й не обходить.

## 0. Як читати документ

Документ навмисно розрізняє чотири види тверджень, щоб технічні пропозиції не
видавалися за продуктові рішення:

| Позначка | Значення |
|---|---|
| **D1–D6** | Продуктові рішення Етапу 10, зафіксовані Product Owner. Не змінюються цим планом. (Не плутати з D1–D6 Етапу 9 у [plan Етапу 9](./stage-9-network-activation.md#6-рішення-product-owner-потрібне-затвердження).) |
| **T1…Tn** | Технічні **пропозиції** цього плану. Потребують затвердження; кожна може бути змінена. |
| **Q1…Qn** | Відкриті питання, відповідь на які може дати лише Product Owner (або юрист). Реалізація відповідного кроку без відповіді не починається. |
| **BLOCKER** | Умова, що забороняє реліз функції. D2 — єдиний blocker цього плану; його знімає **лише** виконання всіх критеріїв §7.2, а не вимкнення функції чи запобіжник. Реальні ПД заборонені **в будь-якому середовищі** до зняття. |

### 0.1 Git-стан на момент підготовки плану (read-only перевірка)

- Поточна гілка — `codex/stage-9-network-activation`, `HEAD = 6ee8d1b` («feat: complete Stage 9
  network activation»). Це та сама гілка, з якої змерджено **PR #46** (стан `MERGED`,
  merge-коміт `1979d4e4`, 25.09.2026). Тобто `HEAD` збігається з вмістом PR #46.
- Локальний `origin/main` **відстає** (`3ea2f02` = PR #45); `git fetch --dry-run` показує
  `3ea2f02..1979d4e main`. Рефи не оновлювалися (fetch не виконувався), тому опис коду
  нижче — за робочим деревом гілки Етапу 9, яке містить увесь PR #46.
- Єдиний сторонній untracked-шлях — `docs/product/` (не чіпається).
- Остання міграція в дереві — `20260925090000_stage9_invitations`; наступні міграції Етапу 10
  мають бути новішими за неї (див. [§6.13](#613-міграційна-послідовність-і-збереження-даних)).

### 0.2 Рішення Product Owner, отримані для кроку 10a

Затверджено Product Owner окремим повідомленням (25.09.2026) — і лише це:

- **Q0.** Гілка реалізації — `codex/stage-10-real-world-history` (створено від актуального `origin/main`
  = `1979d4e`, PR #46).
- **Q10.** Модель тримача книжки — **T1-a**: nullable `Copy.currentHolderId` + `Copy.heldByContactId`.
- **Q13.** Для розбіжностей, перелічених у §5, затверджені roadmap і цей execution plan **мають пріоритет
  над** `docs/specification.md`. Сам `docs/specification.md` не змінюється (і не змінювався). Рішення
  стосується лише переліку §5; будь-яка нова розбіжність зі spec потребує окремого рішення PO.

**Не затверджено повідомленнями §0.2–§0.4 (лишається відкритим):** Q1–Q7, Q9, Q12, Q14 та решта T-пропозицій;
**D2 — відкритий release blocker**, реальні персональні дані гостя заборонені в будь-якому середовищі.
Android Chrome QA Етапу 8 — **NOT RUN**; Етап 8 і beta gate не закриті.

### 0.3 Рішення Product Owner, отримані для кроку 10b

- **Q8 — затверджено.** `LOST` входить у «Хто читав» **лише за наявності `handedAt`**: фактична передача
  відбулася. `LOST` без `handedAt` — не читання. Це уточнює §2 п. 6, §6.7 і H1.

### 0.4 Рішення Product Owner, отримані для кроку 10c

- **Q11 — затверджено.** Власник **може відновити** примірник з архіву (`restore`). Окремого audit-запису про
  archive/restore (`CopyEvent` чи інший) **не створюється**: факт архівування видно з `Copy.archivedAt`, а
  історія позичань лишається в `Loan`. Це уточнює §6.5 і A4.

## 1. Product outcome, метрики, «Не робити»

### 1.1 Product outcome

Власник книжок може вести в BookSwap **усі** свої позики — і ті, що почалися до
реєстрації друга, і ті, що віддані людині без акаунта — і не втрачає історію через
службові дії (видалення, «втратив/знайшов»). Історія відповідає на «хто це справді
брав» (фактична передача), а не «кого це цікавило» (запит).

Критерій успіху для людини: «Я можу внести те, що вже лежить у друзів і знайомих, і
через рік історія примірника все ще повна».

### 1.2 Метрики (без персональних даних)

Нові типи `ProductEvent` (за існуючою схемою: `properties` — порожній strict-об’єкт,
`subjectUserId` — власник, `domainEntityId` лише як вхід dedupe-хешу):

| Метрика | Джерело |
|---|---|
| Частка власників, які внесли ≥ 1 наявну позику | `LOAN_RECORDED` (existing) |
| Confirm rate / decline rate записаних позик | `LOAN_RECORD_CONFIRMED` / `LOAN_RECORD_DECLINED` / `LOAN_RECORD_WITHDRAWN` |
| Медіана часу від запису до відповіді позичальника | різниця дат двох подій одного dedupe-ключа (агрегат, без id) |
| Кількість гостьових позик, запис яких створено (агрегат по власниках) | `GUEST_LOAN_RECORDED` — **лише після зняття D2** |
| Кількість архівованих примірників / відновлених `LOST` | `COPY_ARCHIVED`, `LOAN_RECOVERED` |

Правила: у `properties` немає alias, email, id контакту, назв книжок; ніякий звіт не
групується за контактом. `funnel:report` показує ці лічильники **окремим блоком**, а не
всередині 13 кроків core loop (див. Q9 — чи рахувати записані позики в North Star).
Цілей конверсії не встановлюється (roadmap §2).

### 1.3 Не робити

- Ланцюгове позичання, орендна плата, доставка, передача власності (roadmap).
- Фіктивний `User` для гостя; спільний між власниками каталог контактів (D1).
- Автоматична прив’язка контакту за збігом email (D5); будь-яке переписування минулих дат
  і подій при прив’язці.
- Вигадані `REQUESTED`/`APPROVED` для наявної позики (D6): жодних підроблених request/approve-подій
  і `LOAN_REQUESTED`/`LOAN_APPROVED` у product events.
- Кабінет, логін, повідомлення чи нагадування для гостя, окрім одного листа-запрошення
  (і тільки після зняття D2).
- Вільний текст (`note`, `message`) у гостьових позиках — він міг би нести PII поза alias.
- Імпорт історичних **закритих** позик (CSV чи форма): Етап 10 вносить лише **активну** позику.
- Зміна строків D3, зміна `docs/specification.md`, зміна Stack (NestJS/Next.js/Prisma/PostgreSQL;
  без Redis, JWT, GraphQL, мікросервісів).
- Account deletion/export, retention product events — Етап 13; ratings — відкладено.
- Спрощення `Work → Translation → Edition → Copy`; видалення `Work` (merged `Work` зберігає `mergedIntoId`).

## 2. Межі scope: шість пунктів roadmap

| # | Пункт | У межах Етапу 10 | Поза межами |
|---|---|---|---|
| 1 | **Existing active loan** між зареєстрованими друзями | Власник створює запис із фактичною датою передачі (`handedAt` ≤ сьогодні), опційним `dueAt`; лише для друзів (`ACCEPTED`, не blocked); примірник `AVAILABLE` і вдома; позичальник підтверджує/відмовляє; власник може відкликати й виправити до відповіді; після підтвердження — `HANDED_OVER` без request/approve-подій (D6) | Позичальник як ініціатор запису; запис закритих позик; запис для не-друга; автозакінчення (auto-expiry) непідтвердженого запису (Q6) |
| 2 | **Guest loan** (External borrower) | Контакт у бібліотеці власника (D1), гостьова позика вручну власником (`HANDED_OVER` одразу), повернення/втрата власником, опційний invite з email (D1–D3), retention (D3), видимість (D4), прив’язка до акаунта (D5, крок 10i — Q7) | Доступ гостя до чогось; спільні контакти; нагадування гостю; **використання з реальними ПД до зняття D2** |
| 3 | **Archive / no longer owned** | `Copy.archivedAt`; архів заборонений лише при ексклюзивній позиці; `LOST`-примірник архівувати можна; історія й `Loan` незмінні; архівний примірник не в бібліотеці/discovery/holders/«я маю це» | Передача володіння; відновлення після видалення, що вже відбулося до міграції |
| 4 | **Hard delete лише без loan activity** | `DELETE /me/library/:id` дозволений, лише якщо у примірника **немає жодного** `Loan` будь-якого статусу; інакше 409 з підказкою про архів; FK `Loan → Copy` стає `RESTRICT` | Видалення `Work/Edition`; каскад від видалення акаунта (Етап 13) |
| 5 | **LOST → RECOVERED** | Дія `recover` власника над `LOST`-позикою: `Copy` знову `AVAILABLE`/вдома, окрема подія `RECOVERED` з датою, `Loan.status` лишається `LOST` (минуле не переписується) | Часткове відшкодування, суперечки, повторне «втратив» тієї ж позики |
| 6 | **«Хто читав»** | `GET /works/:id/history` включає лише позики з фактичною передачею (`HANDED_OVER`, `RETURNED`, `LOST` за наявності `handedAt` — Q8 затверджено, §0.3); `REJECTED`/`CANCELLED` (і нові `DECLINED`, `PENDING_CONFIRMATION`) лишаються в activity history примірника та «Моїй історії», але не називаються читанням | Зміна `GET /copies/:id/history` та `GET /me/history` щодо повноти статусів |

## 3. Зафіксовані продуктові рішення D1–D6

Нижче — суть рішень, **без розширень**. Що саме вони НЕ визначають, позначено окремо.

- **D1.** `ExternalBorrower` — окремий контакт у межах бібліотеки власника; без фіктивного `User`;
  без спільного каталогу контактів. Приватний псевдонім обов’язковий; email необов’язковий і
  використовується лише для запрошення.
- **D2.** Власник підтверджує, що **повідомив** гостя про запис. Це **не** згода гостя і **не**
  правова підстава для BookSwap. Правову підставу й дієвий спосіб інформування гостя (зокрема без
  email) **не визначено** → **відкритий release blocker** ([§7](#7-d2--відкритий-release-blocker)).
- **D3.** Email видаляється після завершення сценарію запрошення. Псевдонім зберігається протягом
  активної позики та 90 днів після останнього закриття позики цього контакту; потім прибирається з
  історії, факт позики лишається без контакту. Строк не змінюється цим планом.
- **D4.** Ім’я/псевдонім і email гостя бачить лише власник. Друзі бачать лише анонімний факт
  передачі за чинними правилами історії. Email не потрапляє до history API для друзів, пошуку,
  аналітики.
- **D5.** Автоматичної прив’язки за email немає. Майбутній користувач підтверджує email і окремо
  приймає прив’язку; власник підтверджує тотожність контакту. Історичні дати й події не переписуються.
- **D6.** Уже активну позику між зареєстрованими друзями створює власник із фактичною датою
  передачі; позичальник підтверджує. До відповіді примірник не показується доступним. Після
  підтвердження позика активна без вигаданих request/approve-подій. Відмова й виправлення мають
  прозорий audit trail.

**Що D1–D6 лишають відкритим** (винесено в Q): що саме означає «завершення сценарію запрошення» (Q4);
чи `LOST` — «закриття» для D3 (Q3); строк для контакту без жодної позики (Q2); що означає
«виправлення» в D6 після підтвердження (Q12); чи прив’язка (D5) входить у Етап 10 (Q7).

## 4. Поточний стан коду і розриви з roadmap

Перевірено за робочим деревом (гілка Етапу 9, ≡ PR #46). Номери рядків — на дату плану.

### 4.1 Що вже є й підтримується

- Стейт-машина `REQUESTED → APPROVED → HANDED_OVER → RETURNED/LOST`, `REJECTED`, `CANCELLED`:
  `apps/api/src/loans/loan.transitions.ts` (чиста функція), виконання під `SELECT … FOR UPDATE`
  на `Copy` — `apps/api/src/loans/loan.service.ts:325-446`.
- Історія виводиться з `Loan`: `apps/api/src/history/history.service.ts`, дві проєкції (іменована й
  анонімна) — `history.mapper.ts:60-87`, правила видимості — `apps/api/src/access/visibility.ts`
  (`holderNamesVisibleTo`).
- Блокування видалення/зміни статусу при `APPROVED`/`HANDED_OVER`: `library.service.ts:43,269,314`.
- Аналітика: `ProductEvent`, strict `properties`, dedupe-ключ: `apps/api/src/analytics/`.
- Інвайти Етапу 9 (link/email, лише SHA-256 токена та HMAC email): `apps/api/src/invitations/`.
- Шаблон міграційних тестів на наповненій БД:
  `apps/api/test/db/invitations-migration.db-spec.ts`; runbook-и відкату:
  `docs/runbooks/*-migration-rollback.md`.

### 4.2 Розриви (gap-таблиця)

> Таблиця фіксує стан **до** кроку 10a. Після 10a на рівні схеми й читачів закрито G1–G3, G9 і G13
> (nullable-поля, переписані CHECK-и, безпечні читачі, дайджест без гостьових позик); решта
> розривів — у відповідних кроках.

| # | Розрив | Де саме | Що потрібно для roadmap |
|---|---|---|---|
| G1 | **`Loan.borrowerId` обов’язковий** (`String`, FK на `User`) | `apps/api/prisma/schema.prisma:470,485`; `loan.service.ts:224-232`; `history.mapper.ts:35-36` (`borrower: PublicUserRow`); `notification-digest.service.ts:16,205-220,261` (групує за `borrowerId`) | Гостьова позика без `User`: нульовий borrower + контакт; усі читачі переносять `null` |
| G2 | **`Copy.currentHolderId` обов’язковий** (FK на `User`) | `schema.prisma:423,435`; `library.mapper.ts:205-206` (`isHome`), `:228,256`; `library.service.ts:111-125` (`currentHolderId: { not: userId }` — у Prisma `not` **виключає** `NULL`) | Книжка «в гостя»: тримач ≠ `User`; view «не вдома» не має її губити |
| G3 | **CHECK-обмеження на `Copy` виражені через `currentHolderId = ownerId`** | міграція `20260816194509_loan_state_machine` (`copy_available_is_home`, `copy_away_is_lent_or_unavailable`, `copy_lent_out_is_away`); є `NULL`-пастка (коментар у міграції) | Переписати через `IS DISTINCT FROM` під nullable holder |
| G4 | **Каскадне видалення `Loan` при видаленні `Copy`** | `schema.prisma:483` (`Loan.copy onDelete: Cascade`); `library.service.ts:301-325` (`removeCopy` — блокує лише `APPROVED`/`HANDED_OVER`, тож копія з `RETURNED`-історією **видаляється разом з історією**); закріплено тестом `apps/api/test/db/referential-actions.db-spec.ts:61` («видалення Copy зносить його лоани») | `RESTRICT`; delete лише без loan activity; archive замість delete; **інвертувати** цей тест |
| G5 | **Немає archive** | у `Copy` немає поля; усі вибірки (`library.service.ts`, `catalog/search/network-inventory.service.ts:55`, `catalog/search/work-holders.service.ts`, `library/activation.service.ts:37`, `catalog/catalog.service.ts:125,395,537,617` («у мене вже є»), `analytics/network-activation.service.ts:67`) читають усі `Copy` | Фільтр «не архівний» скрізь, де рахується наявність. CSV-дедуплікація імпорту працює в межах файла й не читає наявні `Copy`, тож архівного DB-фільтра для неї немає (поведінка імпорту не змінюється) |
| G6 | **Обмеження активної позики** — часткові індекс/константи лише для `APPROVED`,`HANDED_OVER` | `init` міграція `one_active_loan_per_copy` (`WHERE status IN ('APPROVED','HANDED_OVER')`); `packages/shared/src/domain/loan.ts` `EXCLUSIVE_LOAN_STATUS`; `enum-parity.spec.ts` | Новий очікувальний стан (T3) має бути ексклюзивним, інакше два записи/апруви на один примірник |
| G7 | **`LOST` термінальний** | `loan.transitions.ts:88-93` (`LOST` → `REFUSE('STATE')`), `:221-237` (`mark_lost`: `holder: null`, `stamp: null` — навіть немає часу «списано»); spec §5.1 | Дія `recover`; час втрати для D3 — з події, бо колонки немає |
| G8 | **«Хто читав» повертає всі позики** | `history.service.ts:148-154` — цикл по **всіх** `copy.loans` без фільтра статусу; `WorkHistoryResponse`; `apps/web/components/HistoryEntryLine.tsx` («Попросили <дата>» завжди) | Фільтр за фактичною передачею; `requestedAt` не вигадується для записаних позик |
| G9 | **`Loan.requestedAt` NOT NULL DEFAULT now()** | `schema.prisma:477` | Запис наявної позики не має «дати запиту» (D6) → T2 |
| G10 | **Немає audit-таблиці подій** | історія = стовпці-таймстемпи `Loan` (spec §4.6); немає часу `LOST`, немає пар «запропоновано/відхилено» | `LoanEvent` (T4) |
| G11 | **Немає сутності контакту** | немає `ExternalBorrower`; email лише як HMAC у `Invitation.recipientEmailHash` (`schema.prisma:797`); прострочені/відкликані інвайти **не чистяться** (Stage 9 §14) | Модель D1, retention D3 |
| G12 | **Немає фонової чистки для PII/retention** | існують лише `NotificationDispatcher`, `NotificationDigestService`, `SessionCleanupService` (`BACKGROUND_MODE`, вимкнені в e2e через `createTestApp()`) | Механізм виконання D3 (T7, Q1) |
| G13 | **Дайджест due-soon/overdue адресований лише позичальнику** | `notification-digest.service.ts:205-220` | Гостьові позики мають бути **виключені** (а не падати на `null`) |
| G14 | **Немає boot-guard для функції з ПД** | є прецедент: `apps/api/src/config/env.validation.ts:139,149` (production-перевірки) | Технічний запобіжник D2 (T9) |

## 5. Розбіжності зі `docs/specification.md` (spec не змінюється цим кроком)

CLAUDE.md: «коли код і spec розходяться — перемагає spec». Етап 10 за roadmap **навмисно**
відходить від spec у таких місцях. **Gate (Q13) — знято для цього переліку:** за CLAUDE.md крок, що
суперечить spec, не стартує без окремого рішення PO; PO ухвалив таке рішення (§0.2): для розбіжностей
нижче roadmap і цей план мають пріоритет. Виконавці `docs/specification.md` не змінюють. Розбіжність,
якої в таблиці немає, цим рішенням **не** покривається.

| Місце spec | Що каже | Що потрібно для Етапу 10 | Крок |
|---|---|---|---|
| §4.6 `Loan.borrowerId` | обов’язковий | nullable + контакт | 10a |
| §4.5 `Copy.currentHolderId` | обов’язковий | nullable + контакт | 10a |
| §5.1 | `LOST` термінальний | `recover` | 10d |
| §5.2 «Видалення примірника заблоковане, поки є лоан у `APPROVED`/`HANDED_OVER`» | блокує лише активні | блокує будь-яку loan activity; є archive | 10c |
| §5.3.2–5.3.4 | інваріанти через `currentHolderId`/`borrowerId` | переформулювати під гостя й `PENDING_CONFIRMATION` | 10a/10e/10f |
| §6.6 «Історія твору — усі лоани» | усі | лише фактична передача | 10b |
| §9 «Історія примірника з іменами» | за `showHolderNames` | гість завжди анонімний (D4) | 10f |

## 6. Пропозиції: контракти, стани, права, видимість, audit, модель даних, міграції

> Усе в цьому розділі — **пропозиції T1…Tn**, не рішення Product Owner. Виняток — посилання на D1–D6.

### 6.1 Модель даних (T1)

Принцип: розширювати, не ламати; жоден рядок `Copy`/`Loan` не видаляється й не переписується.

```
ExternalBorrower            -- D1: контакт у бібліотеці власника
  id, ownerId → User (власник; onDelete: див. R6)
  alias            text NOT NULL   -- приватний псевдонім; єдине PII, яке зберігається
  ownerInformedAt  timestamptz NULL -- D2: коли власник заявив «я повідомив(-ла)». НЕ згода.
  retainUntil      timestamptz NULL -- D3: NULL = є активна позика; інакше момент видалення
  createdAt

Loan  (додається)
  borrowerKind        enum REGISTERED | GUEST   NOT NULL DEFAULT 'REGISTERED'
  borrowerId          → nullable
  borrowerContactId   → ExternalBorrower, ON DELETE SET NULL
  origin              enum REQUESTED | RECORDED_EXISTING | RECORDED_GUEST  DEFAULT 'REQUESTED'
  createdAt           timestamptz NOT NULL DEFAULT now()  (backfill = requestedAt)
  requestedAt         → nullable (T2), DEFAULT now() ЗБЕРІГАЄТЬСЯ
  CHECK: (REGISTERED ∧ borrowerId IS NOT NULL ∧ contactId IS NULL)
      OR (GUEST ∧ borrowerId IS NULL)      -- contactId IS NULL лише після D3-чистки

Copy  (додається)
  archivedAt          timestamptz NULL
  currentHolderId     → nullable
  heldByContactId     → ExternalBorrower, ON DELETE SET NULL
  CHECK (переписані, T1-b): «вдома» ⇔ currentHolderId IS NOT DISTINCT FROM ownerId AND heldByContactId IS NULL

LoanEvent (append-only, T4)
  id, loanId → Loan (RESTRICT), type enum, actorId → User? (SET NULL),
  occurredAt (server now), effectiveAt NULL (фактична дата, напр. дата знахідки),
  payload jsonb  -- strict zod-схема на тип; ЖОДНИХ alias/email/id контакту/вільного тексту
  UNIQUE (loanId) WHERE type = 'RECOVERED'   -- ідемпотентність recover на рівні БД
```

**T1-a (ЗАТВЕРДЖЕНО PO, Q10) — nullable `currentHolderId` + `heldByContactId`.** Мінус: переписати три
CHECK, `isHome`, view «не вдома», типи. Плюс: інваріант «вдома / не вдома» лишається прямо у `Copy`.
**T1-b (відхилено PO)** — лишити `currentHolderId = ownerId` і додати `Copy.holderKind`: ламало б
сенс CHECK `copy_lent_out_is_away` і §5.3.3.

**T2 — `requestedAt` nullable.** Рекомендовано: запис наявної позики не має «дати запиту»; інакше
UI показував би вигадану подію. DEFAULT `now()` залишається, щоб старий код під час rollout не писав
`NULL` у звичайні запити; новий код для `RECORDED_*` явно пише `NULL`. Альтернатива — лишити NOT NULL
і ховати за `origin` (простіше, але «requestedAt» тоді брехня в БД).

**Нові значення enum** (PostgreSQL: нове значення enum не можна використати в тій самій транзакції,
де його додано — тому окрема міграція, див. §6.13):
`LoanStatus += PENDING_CONFIRMATION, DECLINED` (додано в 10a; паритет із `packages/shared`,
`enum-parity.spec.ts`). `NotificationType += LOAN_RECORD_PROPOSED, LOAN_RECORD_CONFIRMED,
LOAN_RECORD_DECLINED, LOAN_RECORD_WITHDRAWN, LOAN_RECORD_AMENDED` — **перенесено з 10a у 10e**: нові типи
сповіщень потрапляли б у матрицю налаштувань користувача (§7.6) без жодної події, а 10a не змінює поведінки.

### 6.2 Стани й переходи (T3)

Розширення `loan.transitions.ts` (чиста функція лишається єдиним місцем рішень; контролер не бачить
статусів):

| Перехід | Хто | Передумови (під `FOR UPDATE` на `Copy`) | Ефекти (одна транзакція) |
|---|---|---|---|
| `— → PENDING_CONFIRMATION` (`POST /loans/recorded`) | власник | друзі `ACCEPTED`, не blocked; `Copy` `AVAILABLE`, вдома, не архівний; `handedAt` ≤ сьогодні; `dueAt` ≥ `handedAt`; немає ексклюзивної позики | `Loan(origin=RECORDED_EXISTING, requestedAt=NULL, handedAt=факт)`; `Copy.status=RESERVED` (**не показується доступним**); наявні `REQUESTED` **не чіпаються**; `LoanEvent RECORD_PROPOSED`; сповіщення позичальнику |
| `PENDING_CONFIRMATION → HANDED_OVER` (`confirm_record`) | позичальник | `Copy` `RESERVED`, вдома | `Copy` → `LENT_OUT`, тримач = позичальник; `handedAt` **не перезаписується**; `LoanEvent RECORD_CONFIRMED`; сповіщення власнику; **лише тут, атомарно в цій самій транзакції**, усі інші `REQUESTED` на цей `Copy` → `REJECTED` зі сповіщеннями (за механізмом `rejectRivals`, `loan.service.ts:461`). Без `LOAN_APPROVED/REQUESTED`. |
| `PENDING_CONFIRMATION → DECLINED` (`decline_record`) | позичальник | — | `Copy` → `AVAILABLE`; `RECORD_DECLINED`; сповіщення; наявні `REQUESTED` **лишаються чинними** |
| `PENDING_CONFIRMATION → CANCELLED` (`withdraw_record`) | власник | — | `Copy` → `AVAILABLE`; `RECORD_WITHDRAWN`; наявні `REQUESTED` **лишаються чинними** |
| `PENDING_CONFIRMATION` (`amend_record`, статус не змінюється) | власник | лише `handedAt`/`dueAt`, лише до відповіді | `RECORD_AMENDED` із попередніми значеннями в `payload`; сповіщення |
| `— → HANDED_OVER` (`POST /loans/guest`) | власник | `Copy` `AVAILABLE`, вдома; контакт належить власнику; D2-guard (T9) | `Loan(borrowerKind=GUEST, origin=RECORDED_GUEST)`; `Copy` `LENT_OUT`, `heldByContactId`; `GUEST_LOAN_RECORDED`; контакт `retainUntil=NULL` |
| `HANDED_OVER → RETURNED` / `LOST` (гостьова) | власник (актор `BORROWER` відсутній) | як для звичайної | як звичайна + `LoanEvent` (час закриття потрібен D3); `retainUntil` перераховується |
| `LOST → LOST` + подія (`recover`) | власник | `Copy` `UNAVAILABLE`, не архівний; подія `RECOVERED` для цієї позики ще не існує | `Copy` → `AVAILABLE`, тримач = власник, `heldByContactId=NULL`; `LoanEvent RECOVERED (effectiveAt=дата знахідки ≤ сьогодні)`; `Loan.status` **лишається** `LOST` |

Ексклюзивність: `PENDING_CONFIRMATION` додається до `EXCLUSIVE_LOAN_STATUS` і до предиката
`one_active_loan_per_copy` (G6) — так запис не конкурує ні з апрувом, ні з іншим записом, і
`removeCopy`/`updateCopy` автоматично його поважають.

**Конкурентні `REQUESTED` (T3, рекомендований варіант; не затверджений PO).** Відхиляти їх при *створенні*
запису передчасно: запис може бути відхилений або відкликаний, і чужі запити втратилися б даремно.
Тому: (1) під час `PENDING_CONFIRMATION` примірник недоступний, а **погодити** чужий `REQUESTED` неможливо —
`approve` вимагає `Copy` `AVAILABLE` (`loan.transitions.ts:106`), тож із `RESERVED` він відмовляє;
нові запити відмовляються за `loan.service.ts:202` (`LOAN_COPY_UNAVAILABLE`); (2) власник і позичальник
і далі можуть `reject`/`cancel` свої `REQUESTED` (вони не вимагають стану `Copy`); (3) наявні `REQUESTED`
відхиляються лише після `confirm_record`, коли книжка справді пішла; (4) після `decline_record`/`withdraw_record`
вони лишаються чинними, а `Copy` знову `AVAILABLE`, тож їх можна погодити. Це **не суперечить** перевіреним
інваріантам (`one_active_loan_per_copy` не включає `REQUESTED`; §5.2 spec дозволяє кільком людям мати
`REQUESTED` на один примірник; `approve` уже вимагає `AVAILABLE`), тож окреме питання до PO не потрібне —
але варіант лишається пропозицією, а не рішенням.

`hand_over`, `approve` тощо для `origin ≠ REQUESTED` не застосовуються: `resolveTransition`
отримує `origin` і відмовляє (`STATE`) у request-flow діях над записаними позиками.

### 6.3 Existing loan між друзями (D6) — деталі

- До відповіді `Copy.status = RESERVED` ⇒ усі наявні предикати «доступний» (`status = AVAILABLE`:
  `loan.service.ts:202`, `network-inventory.service.ts`, `work-holders.service.ts`) працюють без змін.
- Відмова/відкликання не залишає слідів у стані примірника й **не зачіпає чужих `REQUESTED`**, але **завжди** лишає `Loan`
  (`DECLINED`/`CANCELLED`) і `LoanEvent`. Повторний запис після відмови = **новий** `Loan`
  (T5: без зв’язку з попереднім; звʼязок `supersedesLoanId` — лише якщо PO цього захоче).
- Прострочення виводиться як для звичайної позики (`isOverdue`): запис із `dueAt` у минулому одразу
  «прострочено» після підтвердження. Дайджест `LOAN_OVERDUE` спрацює на наступному проході — це
  свідомий наслідок, не спам-канал (див. R8).
- «Виправлення» (D6): у Етапі 10 — **до** відповіді (`amend_record`) і через «відмова → новий запис».
  Правка **після** підтвердження **не входить** у мінімальний план (Q12); `LoanEvent` спроєктовано
  так, щоб її можна було додати без міграції даних.

### 6.4 Гостьова позика (D1–D4)

- Контакти: `POST/GET/PATCH/DELETE /me/external-borrowers`. `DELETE` = дострокова чистка (T7) — лише
  без активної позики; це **не** зміна строку D3, а ручне раннє прибирання (потрібно й для D2-критеріїв).
- Одна позика гостя = один `Loan` із `borrowerKind=GUEST`; **немає** підтвердження гостем (він без
  акаунта); факт підтверджено лише власником — це видно з `origin = RECORDED_GUEST`.
- Заборонено: `note`/`message` у гостьових позиках; email у будь-якому `Loan`/`LoanEvent`/логу.
- Запрошення (T6): `POST /me/external-borrowers/:id/invitation { email }` використовує інфраструктуру
  Етапу 9 (`Invitation`, синхронна відправка, ліміти). Лист **не** містить alias, назв книжок
  і фактів про позики — лише ім’я запрошувача й посилання. **Зміст листа як засіб інформування —
  предмет D2**, а не цього плану.
- **Email не зберігається взагалі** (T6, рекомендовано): Етап 9 відправляє синхронно й пише лише HMAC;
  тож сирий email не має споживача після запиту. Це найпростіше виконання D3 — але потребує Q4.
  Залишається `Invitation.recipientEmailHash` (похідний ідентифікатор гостя) — **Q5**.

### 6.5 Archive і delete (T8)

- `POST /me/library/:copyId/archive` → `archivedAt = now()`. Передумови: власник; немає ексклюзивної
  позики (`PENDING_CONFIRMATION`/`APPROVED`/`HANDED_OVER`). `LOST`-примірник архівується. Відкриті
  `REQUESTED` автоматично → `REJECTED` (з сповіщенням, як при апруві).
- `POST /me/library/:copyId/restore` → `archivedAt = NULL` (Q11 затверджено, §0.4: відновлення потрібне; окремого
  audit archive/restore немає).
- `DELETE /me/library/:copyId` — лише якщо `NOT EXISTS Loan` **будь-якого** статусу;
  інакше `409 COPY_HAS_LOAN_HISTORY` (нова причина, окремо від наявного `COPY_HAS_ACTIVE_LOAN`).
  Рішення приймається в транзакції під `FOR UPDATE` на `Copy`; FK `RESTRICT` — друга лінія
  захисту (гонка з `POST /loans` дає `P2003` → той самий код).
- Видимість архівного примірника: зникає з `GET /me/library` (без `?archived=true`), discovery,
  holders, «у мене вже є», activation-лічильників і CSV-дедупа; **історія й учасники не втрачають
  доступу** (`me/history`, `copies/:id/history` за незмінними правилами `copyVisibleTo`).

### 6.6 LOST → RECOVERED (T3, T4)

`Loan.status` лишається `LOST`; «знайшли» — окрема подія `RECOVERED` з `effectiveAt`. Ніяких змін
`handedAt/returnedAt`. Часткове унікальне обмеження гарантує, що подія одна на позику (конкурентні
`recover` → другий отримує 409). `recover` для архівного примірника відмовляє (`COPY_ARCHIVED`):
спершу `restore`. Для **наявних** `LOST`-позик (до міграції) дія доступна одразу: `LoanEvent` для них
створюється лише в момент `recover`; минулого «списано» ніхто не вигадує.

### 6.7 «Хто читав» (T8)

- `workHistory` фільтрує: `status ∈ {HANDED_OVER, RETURNED, LOST}` **і** `handedAt != null` (Q8 затверджено,
  §0.3: `LOST` — читання лише за фактичної передачі; `LOST` без `handedAt` — ні). `REQUESTED`,
  `APPROVED`, `REJECTED`, `CANCELLED`, `PENDING_CONFIRMATION`, `DECLINED` — **не читання**.
- Activity history: `GET /copies/:id/history` і `GET /me/history` показують усі статуси, як зараз.
  `PENDING_CONFIRMATION` і `DECLINED` бачать лише сторони позики (T5: для друзів/інших їх немає —
  це претензія, а не факт).
- Гостьові рядки — завжди анонімні для не-власника, навіть при `showHolderNames = true` (D4).
- `HistoryEntryLine`: для `origin ≠ REQUESTED` не друкується «Попросили …»; показується
  «Записано власником» і фактичні дати. Джерело істини — `origin` (нове поле контракту `HistoryEntry`), а не
  `requestedAt`: БД має дефолт `now()`, тож записана позика може мати ненульовий `requestedAt`.

### 6.8 Audit trail (T4)

`LoanEvent` append-only на рівні коду (жодних `update`/`delete` API, тест, що це так). Тригер БД проти
`UPDATE/DELETE` — опція; вона ускладнює тестові cleanup-и й Етап 13, тому **не обов’язкова** (R7).
Події пишуться для позик з `origin ≠ REQUESTED` та для `RECOVERED`; звичайні request-flow позики
лишають чинні таймстемпи й **не отримують заднім числом вигаданих подій**.

Типи: `RECORD_PROPOSED`, `RECORD_AMENDED`, `RECORD_CONFIRMED`, `RECORD_DECLINED`, `RECORD_WITHDRAWN`,
`GUEST_LOAN_RECORDED`, `LOAN_RETURNED`, `LOAN_LOST`, `RECOVERED`, `LINK_*` (10i). Кожен `payload` — strict-zod
за типом (за зразком `analytics/product-event.types.ts`).

### 6.9 Матриця видимості

| Дані | Власник | Позичальник (зареєстр.) | Друг | Інший | Аналітика |
|---|---|---|---|---|---|
| Alias гостя | так | — | **ні** | ні | **ні** |
| Email гостя | не зберігається (T6) | — | ні | ні | ні |
| Гостьова позика (факт, дати) | так, з alias | — | анонімно («у когось»), навіть якщо `showHolderNames=true` | ні | лічильник без id |
| `PENDING_CONFIRMATION`/`DECLINED` | так | так | **ні** | ні | лише лічильники подій |
| Записана позика після підтвердження | з іменами | з іменами | за чинними правилами `showHolderNames` | ні | — |
| `LoanEvent` | усі події своїх позик | події своїх позик | ні | ні | ні |
| Архівний примірник | у «Архіві» | у своїй історії | лише через чинні правила історії (не в бібліотеці/discovery) | ні | — |

### 6.10 API-контракти (T; `/api/v1`, схеми в `packages/shared`, DTO з runtime-валідацією, помилки з `code`)

| Метод і шлях | Хто | Тіло → відповідь | Нові коди помилок |
|---|---|---|---|
| `POST /loans/recorded` | власник | `{copyId, borrowerId, handedAt, dueAt?}` → `201 {loan}` (`PENDING_CONFIRMATION`) | `LOAN_RECORD_DATE_INVALID`, `LOAN_COPY_UNAVAILABLE` (наявний), `FORBIDDEN` (не друг), `COPY_ARCHIVED` |
| `PATCH /loans/:id {action}` | сторони | нові дії: `confirm_record`, `decline_record`, `withdraw_record`, `amend_record{handedAt?,dueAt?}`, `recover{effectiveAt?}` (єдина точка переходів зберігається) | `LOAN_INVALID_TRANSITION` (наявний) |
| `POST /me/external-borrowers` | власник | `{alias, ownerInformed: true}` → `201` (**`ownerInformed` — заява власника, не згода**) | `FEATURE_DISABLED` (T9), `VALIDATION_ERROR` |
| `GET/PATCH/DELETE /me/external-borrowers[/:id]` | власник | alias видимий лише тут | `EXTERNAL_BORROWER_HAS_ACTIVE_LOAN` |
| `POST /loans/guest` | власник | `{copyId, externalBorrowerId, handedAt, dueAt?}` → `201 {loan}` (`HANDED_OVER`) | `FEATURE_DISABLED` |
| `POST /me/external-borrowers/:id/invitation` | власник | `{email}` → `201` без відлуння email | ліміти Етапу 9 |
| `POST /me/library/:copyId/archive`, `…/restore` | власник | `→ {copy}` | `COPY_HAS_ACTIVE_LOAN` |
| `DELETE /me/library/:copyId` | власник | зміна: 409 при будь-якій loan activity | `COPY_HAS_LOAN_HISTORY` |
| `GET /works/:id/history` | друг/власник | вужча множина (§6.7); контракт змінюється | — |
| `GET /me/library?archived=true` | власник | | — |
| Прив’язка (10i): `POST /me/external-borrowers/:id/link-proposals`, `PATCH /me/link-proposals/:id {action}` | власник / користувач | стани `PENDING_OWNER → PENDING_USER → LINKED` / `DECLINED` / `REVOKED`; для accept потрібен `emailVerified` | `LINK_EMAIL_UNVERIFIED` |

### 6.11 Retention D3 — механізм виконання (T7)

**Визначення (лише виконання D3, без зміни строків):**

- «Закриття позики» = `RETURNED` (`returnedAt`) або `LOST` (час події `LOAN_LOST`, бо колонки часу
  втрати немає — G7; Q3).
- `retainUntil = NULL`, поки в контакту є `HANDED_OVER`; після закриття останньої —
  `max(closedAt) + 90 днів`. Нова гостьова позика скидає `retainUntil` в `NULL`.
- Значення перераховується **в тій самій транзакції**, що й перехід позики.

**Чистка (T7, вибір виконавця — Q1):** ідемпотентна операція
`ExternalBorrower WHERE retainUntil <= now()` → пачками, `FOR UPDATE SKIP LOCKED`, у транзакції:
`DELETE` контакту (`Loan.borrowerContactId`/`Copy.heldByContactId` → `SET NULL` за FK; `borrowerKind`
лишається `GUEST` — «факт позики без контакту»). Варіанти виконавця: **(a)** інтервальний сервіс за
зразком `SessionCleanupService` (керується `BACKGROUND_MODE`, у e2e вимкнений; `run()` явно в тесті);
**(b)** CLI-команда за зразком `apps/api/src/cli/*` + зовнішній scheduler. Рекомендація: (a) із
тим самим ядром, доступним як `run()`/CLI. Умова: перевірити ціль розгортання API — інтервальні
таймери не працюють у serverless.

**Граничні випадки:**

1. Контакт без жодної позики — строк не визначено D3 (Q2); рекомендація: 90 днів від `createdAt`.
2. Кілька позик — годинник від **останнього** закриття; повторна позика в межах 90 днів скасовує чистку.
3. `LOST` — за D3 це закриття; наслідок (R3): власник може втратити єдиний запис, хто тримає книжку.
   `recover` після чистки лишається можливим (без alias, лише подія й стан `Copy`).
4. Дострокова ручна чистка (`DELETE` контакту без активної позики) — поза строком D3; безпечніша, не суперечить.
5. Прив’язка (D5): після чистки контакту зв’язок «контакт → користувач» зникає разом із ним;
   минулі дати й події лишаються (`Loan`/`LoanEvent` не змінюються).
6. Резервні копії: відновлення з backup **повертає** стерті alias → після кожного restore чистка
   запускається негайно (пункт для runbook Етапу 11).
7. `Loan.message`/`note` для гостя заборонені (виключає витік PII поза alias).
8. Логи, `ProductEvent`, `Notification.payload`, sentry-подібні канали не містять alias (тест на витік).

### 6.12 Прив’язка контакту до акаунта (D5) — крок 10i, Q7

Двосторонньо й у будь-якому порядку: **користувач** (з підтвердженим email) приймає прив’язку;
**власник** підтверджує тотожність. Ініціація: (a) власник пропонує другові-користувачу, або
(b) користувач, що прийшов за інвайтом контакту, створює пропозицію, яку власник підтверджує.
Автоматичного зіставлення за email **немає** (ні при реєстрації, ні при логіні).

Наслідки, які треба явно затвердити: минулі гостьові позики **не** переписуються й для друзів
лишаються анонімними (прив’язка не деанонімізує заднім числом); активну гостьову позику на момент
прив’язки — політика (T10, Q7): лишається гостьовою до закриття *або* конвертується в звичайну
(`borrowerId = user`) лише за окремою згодою обох; перша безпечніша.

### 6.13 Міграційна послідовність і збереження даних

Принципи (з runbook-ів): застосовані `migration.sql` не редагуються; `prisma migrate reset` не
використовується; SQL для CHECK/індексів — вручну; еквівалентність схемі перевіряється
`prisma migrate diff --exit-code`; **кожна** міграція має db-spec на наповненій БД за зразком
`invitations-migration.db-spec.ts`.

| # | Міграція (імена — умовні) | Що робить | Безпека для наявних даних |
|---|---|---|---|
| M1 ✅ 10a | `stage10_enums` | `ADD VALUE` до `LoanStatus` (`NotificationType` — у 10e); нові enum-и `LoanOrigin`, `BorrowerKind`, `LoanEventType` | окремо від решти: нове значення enum не можна використати в тій самій транзакції |
| M2 ✅ 10a | `stage10_expand` | нові таблиці `ExternalBorrower`, `LoanEvent`; колонки `Loan.borrowerKind/origin/createdAt/borrowerContactId`, `Copy.archivedAt/heldByContactId`; `DROP NOT NULL` на `Loan.borrowerId`, `Loan.requestedAt`, `Copy.currentHolderId`; `createdAt` backfill = `requestedAt`; нові CHECK-и додаються **до** зняття старих | усі наявні рядки: `borrowerKind=REGISTERED`, `origin=REQUESTED`, `archivedAt=NULL`; жоден рядок не видаляється; дефолт `requestedAt = now()` зберігається |
| M3 ✅ 10c | `20260926090200_stage10_delete_restrict` (**разом із кроком 10c**) | `Loan_copyId_fkey`: `CASCADE → RESTRICT` | змінює лише **майбутню** поведінку; тест G4 інвертується |
| M4 | `stage10_recovered_unique` (крок 10d) | `UNIQUE (loanId) WHERE type='RECOVERED'` | нова таблиця порожня |
| M5 | `stage10_exclusive_pending` (крок 10e) | перестворення `one_active_loan_per_copy` із `PENDING_CONFIRMATION`; для наявних даних предикат лише розширюється (нових значень у даних ще немає) | індекс будується на наявних даних — перевірити час; для поточних обсягів достатньо звичайного `CREATE`, `CONCURRENTLY` за потреби |
| M6 | `stage10_link` (крок 10i, якщо Q7 = так) | `ExternalBorrowerLink` | нова таблиця |

**Як зберігаються всі наявні `Copy`/`Loan`:** міграції лише додають і послаблюють; ні `DELETE`, ні
`UPDATE` наявних фактів, крім backfill `createdAt`. Старі `RETURNED/LOST/REJECTED/CANCELLED` лишаються
як були; старі `LOST`-примірники стають відновлюваними, історія не змінюється.
**Що не можна відновити:** примірники з історією, **уже видалені** старою каскадною поведінкою
до міграції — лише з backup. Це відома межа (R2); план її не приховує.

**Безпечне розгортання:** (1) backup БД; (2) M1–M2 (сумісні зі старим кодом: старий код не бачить нових
колонок, вставки працюють завдяки дефолтам); (3) деплой API+web із **вимкненими** новими функціями;
(4) M3 разом із кодом `removeCopy` (не окремо — інакше старий `DELETE` дасть 500 через FK); (5) вмикання
existing-loan; (6) гостьові ендпоінти лишаються за D2-guard. **Відкат:** лише вперед (feature-flag off +
forward-fix), як у чинних runbook-ах; після появи рядків Етапу 10 (nullable borrower, `PENDING_CONFIRMATION`,
архів) відкат коду на старий **небезпечний**. Runbook `docs/runbooks/stage-10-migration-rollback.md`
(українською) — результат кроку 10a.

### 6.14 Аналітика

Нові типи в `product-event.types.ts` (порожні `properties`): `LOAN_RECORDED`, `LOAN_RECORD_CONFIRMED`,
`LOAN_RECORD_DECLINED`, `LOAN_RECORD_WITHDRAWN`, `GUEST_LOAN_RECORDED`, `COPY_ARCHIVED`, `LOAN_RECOVERED`.
`subjectUserId` — власник; id контакту й позики — лише в dedupe-хеші. Записані позики **не** породжують
`LOAN_REQUESTED/LOAN_APPROVED` і за замовчуванням не входять до 13 кроків funnel (Q9).

## 7. D2 — відкритий release blocker

**Статус: ВІДКРИТО. Не вирішено цим планом.** Функцію гостьових позик **не можна використовувати з
реальними персональними даними в жодному середовищі** (development, staging, «production-like», production,
private beta), доки рішення не ухвалене й не реалізоване. Цей gate **не переноситься на «перед beta»** і не є
«лише production»-обмеженням. Технічний запобіжник §7.3 лише дозволяє безпечно розробляти й тестувати код із
**синтетичними** даними; він **не знімає D2**. D2 лишається відкритим release blocker до виконання **всіх**
критеріїв §7.2.

### 7.1 Що відомо

- Прапорець власника «Я повідомив(-ла) людину» — **заява власника**, а не згода гостя й не правова
  підстава BookSwap. У UI, API-полі (`ownerInformed`), документації й аналітиці він **не називається
  «згодою»**; поле `ownerInformedAt` — лише журнал заяви.
- Правова підстава обробки alias (і будь-яких даних гостя) — **не визначена**. Її не вигадує цей план.
- Спосіб інформування гостя **без email** — не визначений; із email — зміст і момент листа не визначені.

### 7.2 Критерії зняття blocker (усі обов’язкові, у порядку)

1. **Погоджена правова підстава** — рішення Product Owner/юриста, задокументоване (хто, коли,
   на що спирається, обсяг даних, роль BookSwap vs власника).
2. **Дієвий спосіб інформування гостя**: (a) *з email* — зміст листа, момент, посилання на
   повідомлення про обробку, спосіб заперечення/стирання; (b) *без email* — конкретний механізм, який
   реально доходить до людини (не «власник сам скаже»), і як це доводиться.
3. **Канал прав гостя** (доступ, виправлення, стирання, заперечення) без акаунта — визначений і
   оброблюваний (зв’язок із `DELETE` контакту й D3-чисткою).
4. **Реалізація** усього з п. 1–3 (тексти, ендпоінти, UI, журнал).
5. **Перевірка**: автоматичні тести (див. §9, блок D2) + ручна перевірка тексту/потоку юристом чи PO.
6. **Документування** українською в `docs/` (політика/повідомлення, user-guide, runbook чистки) і
   письмове рішення PO про зняття; лише **тоді** прибирається запобіжник з §7.3 — окремою зміною
   коду, що посилається на це рішення.

### 7.3 Технічний запобіжник до зняття (T9)

1. **Boot-guard** у `apps/api/src/config/env.validation.ts` (за прецедентом рядків 139/149):
   `GUEST_LOANS_ENABLED` (default `false`); при `NODE_ENV=production` значення `true` **завжди**
   відхиляє запуск (константа `GUEST_LOANS_PRODUCTION_ALLOWED = false` змінюється лише окремою зміною коду, що спирається на
   письмове рішення PO про зняття D2).
2. **API-guard:** усі ендпоінти §6.4 і `ExternalBorrower`-мутації при вимкненому прапорі повертають
   `403 FEATURE_DISABLED` до будь-якої роботи з БД; читання контактів — те саме.
3. **Web:** UI гостьових позик не рендериться при вимкненому прапорі (прапор віддається сервером у
   `GET /me`-подібній відповіді, не в клієнтському env).
4. **Поза production (пропозиція):** прапор дозволений **лише для синтетичних даних**. Код не може відрізнити
   реальну людину від синтетичної, тож запобіжник доповнюється: додаткове явне підтвердження в конфігурації
   (`GUEST_LOANS_SYNTHETIC_ONLY=true` обов’язкове, коли прапор увімкнено), видимий банер «лише тестові дані»
   в UI й запис про це в README/runbook. Це знижує ризик, але **не** гарантує відсутність реальних ПД —
   тому заборона реальних ПД в будь-якому середовищі є організаційною вимогою, яку тримає Product Owner.
   Середовища «production-like» для beta (Етап 11) мають `NODE_ENV=production` → boot-guard працює й там.
5. **Реєстр:** пункт «D2 відкрито» Product Owner вносить до release gate Beta в roadmap (цей документ
   roadmap не змінює — Q14). Умова «завершені етапи 8–10» **не вважається виконаною**, доки D2 відкритий:
   вимкнена або ізольована функція **не** означає знятий blocker і **не** дозволяє позначити Етап 10 чи
   beta gate виконаними.

Решта Етапу 10 (existing loan, archive/delete, recovery, «Хто читав») **не залежить від D2**: там обидві
сторони — зареєстровані користувачі. Тому D2 не блокує **розробку** кроків 10a–10e. Але **Етап 10 у цілому
не може бути позначений завершеним**, поки D2 відкритий (див. DoD §10).

## 8. Послідовність реалізаційних кроків

Кроки виконуються **послідовно**: наступний не стартує, доки не виконано критерії готовності попереднього
(CLAUDE.md: «лише поточний підетап»). Кожен крок перевіряється `./gate.sh` і звітом за CLAUDE.md
(«Reporting»). Виконавець кроку **не виконує** staging, commit, push, merge, rebase чи створення PR —
це робить Product Owner (CLAUDE.md, «Workflow»); план цього не автоматизує. Залежності між кроками
лишаються незмінними відносно попередньої редакції плану.

| Крок | Зміст | Залежить від | Готово, коли |
|---|---|---|---|
| **10.0** ✅ (Q0, Q10, Q13) | Відповіді PO, що блокують **перший реалізаційний крок (10a)**: **Q0** (гілка), **Q13** (gate зі специфікацією: PO оновлює spec або явно вирішує пріоритет — виконавець spec не змінює), **Q10** (модель тримача книжки). Q14 (roadmap-gate D2) PO вносить до roadmap до будь-якого релізного рішення. Інші Q блокують лише свої кроки: Q8 → 10b; Q11 → 10c (закрито, §0.4); Q6, Q12 → 10e; Q1–Q5 → 10g/10h; Q7 → 10i; Q9 → 10j | — | Письмові відповіді PO; жоден Q/T не вважається затвердженим без них |
| **10a** ✅ | **Expand-схема, без зміни поведінки.** M1+M2 (`NotificationType` — у 10e); Prisma-схема; shared-enum-и; nullable-safe читачі (`history.mapper`, `library.mapper`, `notification-digest` виключає `borrowerKind=GUEST`, `library.service` view «не вдома»); переписані CHECK; runbook `stage-10-migration-rollback.md` | 10.0 | Наявні тести зелені; db-spec на наповненій БД (§9 MIG-*); `migrate diff` чистий; жодної нової функціональності |
| **10b** ✅ | **«Хто читав»**: фільтр `workHistory`; `HistoryEntryLine` без «Попросили» для non-request; оновлений контракт | 10.0 (Q8, Q13) | Тести H-* ; `GET /copies/:id/history` без змін |
| **10c** ✅ | **Archive + safe delete** + M3; `COPY_HAS_LOAN_HISTORY`; фільтр архівних у всіх вибірках G5; UI «Архів»; інверсія `referential-actions.db-spec.ts:61` | 10a | Тести A-*, DEL-*; жоден `Loan` не зникає при видаленні/архіві |
| **10d** | **`LoanEvent` + `recover`** + M4; час `LOAN_LOST` для нових позик; UI «Знайшлася» | 10a, 10c (архів у передумовах) | Тести REC-*; повторне `recover` ідемпотентне |
| **10e** | **Existing loan (D6)**: `POST /loans/recorded`, `confirm/decline/withdraw/amend`; M5; `PENDING_CONFIRMATION` в `EXCLUSIVE_LOAN_STATUS`; сповіщення; UI обох сторін; події аналітики | 10a, 10d | Тести E-*, C-*; примірник ніколи не «доступний» до відповіді; наявні `REQUESTED` відхиляються лише після `confirm_record` |
| **10f** | **Контакти + гостьова позика за D2-guard** (запобіжник T9 реалізується **першою частиною кроку**, до будь-якого гостьового ендпоінта): `ExternalBorrower`, `POST /loans/guest`, return/lost, видимість D4; лише синтетичні дані | 10a, 10d, 10e | Тести GL-*, P-*; при вимкненому прапорі жоден запис PII неможливий |
| **10g** | **Invite для гостя**: інтеграція з Етапом 9; email не зберігається (T6); рішення Q5 щодо `recipientEmailHash` | 10f | Тести I-*; email відсутній у БД/логах/API |
| **10h** | **Retention D3**: `retainUntil`, чистка, `run()`/CLI, граничні випадки | 10f (Q1–Q3) | Тести RET-*; **обов’язково до вмикання гостя будь-де з ПД** |
| **10i** | **Прив’язка D5** (за Q7) + M6 | 10f, 10g, 10h | Тести L-* |
| **10j** | **Закриття**: funnel-блок метрик (§1.2), українська документація (README/docs/user-guide), звіт етапу, `Не робити` перевірено | усі попередні | Повний `./gate.sh`; DoD §10 (крім п. 2, що потребує зняття D2 за §7.2); D2 **лишається відкритим release blocker**, доки не виконано всі критерії §7.2 |

Після 10h і до зняття D2 гостьові кроки лишаються виконаними **технічно**, але вимкненими (§7.3); це **не**
знімає D2 і не робить Етап 10 чи beta gate виконаними.

## 9. Матриця майбутніх тестів

Рівні: **U** = unit (`pnpm --filter @bookswap/api test`, `pnpm --filter @bookswap/shared test`),
**E** = e2e з реальною БД (`pnpm --filter @bookswap/api test:e2e`; один файл:
`pnpm --filter @bookswap/api exec node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json test/<file>`),
**DB** = db-spec на scratch-БД (`pnpm --filter @bookswap/api test:db` — включає e2e), **W** = web
(`pnpm --filter @bookswap/web test`), **M** = manual. Повний прогін — `./gate.sh`.
Фоновий планувальник у e2e вимкнений (`createTestApp()`); тести retention/дайджесту викликають `run()`
явно (CLAUDE.md). Конкурентні сценарії — за `test/concurrency.helpers.ts`.

### 9.1 Existing loan (D6) і конкуренція

| ID | Сценарій | Рівень |
|---|---|---|
| E1 | Друзі створюють запис із `handedAt` у минулому → `PENDING_CONFIRMATION`, `Copy=RESERVED`, немає `requestedAt`, немає `LOAN_REQUESTED/APPROVED` подій | E |
| E2 | Підтвердження → `HANDED_OVER`, `Copy=LENT_OUT`, holder=borrower, `handedAt` **не** змінено, є `RECORD_CONFIRMED` | E |
| E3 | Відмова → `DECLINED`, `Copy=AVAILABLE`, `Loan` і `LoanEvent` збережені | E |
| E4 | Відкликання власником / `amend_record` до відповіді; після — 409 | E |
| E5 | Негатив: не друг, blocked, сам собі, майбутня `handedAt`, `dueAt < handedAt`, `Copy` не `AVAILABLE`, архівний | E |
| E6 | Permission: чужий користувач → 404; власник не може `confirm`; позичальник не може `withdraw/amend` | E |
| E7 | Доступність: до відповіді примірник не в discovery/holders як доступний; `canRequest=false`; не витікає стороні третій особі | E |
| E8 | Створення запису при наявних `REQUESTED` → вони лишаються `REQUESTED`, їхні власники не отримують `LOAN_REJECTED` | E |
| C1 | Конкуренція: два одночасні записи на один `Copy` → один успіх (`one_active_loan_per_copy`) | E |
| C2 | Запис ∥ апрув чужого `REQUESTED` → рівно один переможець (інший 409 `LOAN_COPY_UNAVAILABLE`/`LOAN_INVALID_TRANSITION`); чужі `REQUESTED` **не** відхиляються самим записом | E |
| C3 | `confirm` ∥ `withdraw` → один результат, узгоджений стан `Copy` | E |
| C4 | Запис ∥ `DELETE` копії / архівування → жодних осиротілих станів | E |
| C5 | Юніт-таблиця переходів (`loan.transitions.spec.ts`): усі нові рядки + `origin`-відмови | U |
| C6 | Прострочений запис → `isOverdue`; дайджест не дублює (dedupe) | E |
| C7 | `confirm_record` → усі інші `REQUESTED` на `Copy` атомарно `REJECTED` зі сповіщеннями; помилка посеред транзакції відкочує все (`loans-rollback`-стиль) | E |
| C8 | `decline_record` і `withdraw_record` → чужі `REQUESTED` лишаються `REQUESTED`, `Copy=AVAILABLE`, і їх можна погодити | E |
| C9 | Під `PENDING_CONFIRMATION` спроба погодити чужий `REQUESTED` → 409; новий запит → `LOAN_COPY_UNAVAILABLE`; `reject`/`cancel` власного `REQUESTED` дозволені | E |
| C10 | `confirm_record` ∥ `cancel` чужого `REQUESTED` → узгоджений результат, без «висячих» `REQUESTED` на `LENT_OUT` примірнику | E |

### 9.2 Guest, privacy, PII

| ID | Сценарій | Рівень |
|---|---|---|
| GL1 | Гостьова позика створюється без `User`; `Copy` `LENT_OUT` із `heldByContactId`; return/lost власником | E |
| GL2 | Обов’язковий alias; `note/message` для гостя відхиляється | E |
| GL3 | Контакт власника A недоступний власнику B (404) і не використовується в його позиках | E |
| GL4 | Один контакт — кілька позик; `retainUntil` скидається | E |
| P1 | Друг бачить гостьову позику лише анонімно, **навіть при `showHolderNames=true`**; немає alias/contactId/loanId | E |
| P2 | Alias/email відсутні у: history API для друзів, `/works/:id/holders`, discovery, `/loans` третіх осіб, notifications payload | E |
| P3 | Alias/email відсутні в `ProductEvent` (ніяких полів, крім strict-порожніх), у логах (перехоплення logger), у листі-запрошенні | E |
| P4 | Digest due-soon/overdue не падає й не шле нічого на гостьових позиках | E |
| P5 | Snapshot-тест форми відповідей: жодного ключа `alias`/`email` за межами `/me/external-borrowers` | U |
| GATE1 | Прапор off: усі гостьові ендпоінти → 403 `FEATURE_DISABLED`; в БД жодного `ExternalBorrower` | E |
| GATE2 | `NODE_ENV=production` + `GUEST_LOANS_ENABLED=true` → boot падає (`env.validation.spec.ts`) | U |
| GATE3 | Web не рендерить гостьовий UI при off | W |
| GATE4 | UI/API/док не містять слова «згода» щодо гостя (grep-тест на ключі локалізації) | U/W |

### 9.3 Invite і linking

| ID | Сценарій | Рівень |
|---|---|---|
| I1 | Invite для контакту через Етап 9 інфраструктуру; ліміти; лист без alias/назв книжок | E |
| I2 | Сирого email немає в БД після запиту (перевірка всіх таблиць), у відповіді API, у логах | E |
| I3 | Збій відправки → інвайт відкликано, email ніде не залишився | E |
| I4 | `Invitation.recipientEmailHash` — за рішенням Q5 | E |
| L1 | Реєстрація з тим самим email **не** створює прив’язку (D5) | E |
| L2 | Прив’язка: user accept (лише з `emailVerified`) + owner confirm, у будь-якому порядку → `LINKED`; одностороння → не прив’язано | E |
| L3 | Після `LINKED` минулі `Loan`/`LoanEvent` байт-в-байт незмінні; для друзів усе ще анонімно | E/DB |
| L4 | Відмова/відкликання прив’язки; повторна пропозиція | E |
| L5 | Активна гостьова позика в момент прив’язки — за Q7/T10 | E |

### 9.4 Retention (D3)

| ID | Сценарій | Рівень |
|---|---|---|
| RET1 | Активна позика → `retainUntil = NULL`, чистка не чіпає | E |
| RET2 | Закриття (`RETURNED`) → `retainUntil = returnedAt+90d`; за 89 дн — alias є, за 90 — стерто, `Loan` лишився з `borrowerKind=GUEST`, без контакту | E (керований годинник) |
| RET3 | Нова позика в межах 90 дн скасовує чистку; кілька позик — від останнього закриття | E |
| RET4 | `LOST` закриває (Q3); `recover` після чистки працює без alias | E |
| RET5 | Контакт без позик (Q2) | E |
| RET6 | Ідемпотентність, `SKIP LOCKED` при двох одночасних `run()`, часткова відмова не лишає напівстертого | E |
| RET7 | Дострокове `DELETE` контакту: 409 при активній позиці, інакше чистка того ж вигляду | E |
| RET8 | Після чистки жоден API/лог/аналітика не повертає alias (повторення P2 на очищених даних) | E |
| RET9 | Ручний прогін після імітації restore з backup | M/runbook |

### 9.5 Archive, delete, recovery, «Хто читав»

| ID | Сценарій | Рівень |
|---|---|---|
| A1 | Archive при `APPROVED/HANDED_OVER/PENDING_CONFIRMATION` → 409 `COPY_HAS_ACTIVE_LOAN`; при `LOST` — дозволено | E |
| A2 | Archive: `Loan`/`LoanEvent` не змінено; примірник зник із бібліотеки, discovery, holders, «у мене вже є», activation-лічильника; CSV-дедуп не читає `Copy` (лише в межах файла), тож архівного фільтра не потребує; історія доступна за старими правилами | E |
| A3 | Відкриті `REQUESTED` при архіві → `REJECTED` зі сповіщенням | E |
| A4 | `restore` (Q11 затверджено): archive → restore повертає примірник у звичайні вибірки (E, 10c). Recover на архівному → `COPY_ARCHIVED` — перевірка в 10d, коли з'явиться `recover` | E |
| DEL1 | Delete примірника **без** жодного `Loan` — 204 | E |
| DEL2 | Delete з будь-яким `Loan` (навіть `REJECTED`/`CANCELLED`/`RETURNED`) → 409 `COPY_HAS_LOAN_HISTORY`, `Loan` цілий | E |
| DEL3 | Гонка: delete ∥ `POST /loans` → без 500; FK `RESTRICT` мапиться в домен-код | E |
| DEL4 | DB-рівень: `DELETE FROM "Copy"` з `Loan` падає (`referential-actions.db-spec` інвертований) | DB |
| REC1 | `recover`: `Copy` → `AVAILABLE`/вдома; `Loan.status` лишається `LOST`; `handedAt` незмінний; є `RECOVERED` з `effectiveAt` | E |
| REC2 | Подвійне/конкурентне `recover` → одна подія, другий 409 (UNIQUE) | E |
| REC3 | Recover: не власник → 404/403; не `LOST` → 409; дата в майбутньому → 400 | E |
| REC4 | Після recover примірник знову доступний, новий запит проходить; старий `LOST` у історії | E |
| REC5 | Наявні (до міграції) `LOST`-позики відновлювані | DB |
| H1 | `workHistory` віддає лише `HANDED_OVER/RETURNED/LOST` із `handedAt != null` (Q8: `LOST` з і без `handedAt`); **не** віддає `REQUESTED/APPROVED/REJECTED/CANCELLED/PENDING_CONFIRMATION/DECLINED` | E |
| H2 | `copies/:id/history` і `me/history` **зберігають** `REJECTED/CANCELLED` | E |
| H3 | Матриця ролей для work history: власник / друг + `showHolderNames` on/off / інший (403) / blocked | E |
| H4 | `PENDING_CONFIRMATION/DECLINED` невидимі друзям і не «читання» | E |
| H5 | Web: `HistoryEntryLine` не друкує «Попросили» для записаних; підпис «Записано власником» | W |

### 9.6 Міграція на наявних даних і контракти

| ID | Сценарій | Рівень |
|---|---|---|
| MIG1 | Scratch-БД до M1 → наповнена (Copy у всіх статусах, Loan у всіх 7 статусах, `LOST`) → M1–M2: усі наявні рядки `to_jsonb` збігаються по старих колонках; нові колонки мають очікувані дефолти; лічильники таблиць не змінилися | DB |
| MIG2 | Нові CHECK-и приймають усі наявні рядки й відхиляють порушення (guest без контакту, `LENT_OUT` вдома тощо) | DB |
| MIG3 | Часткові індекси: 2 ексклюзивні позики на `Copy` → помилка, включно з `PENDING_CONFIRMATION` (M5) | DB |
| MIG4 | `prisma migrate diff --exit-code` між міграціями і `schema.prisma` | CLI |
| MIG5 | Enum parity (Prisma ↔ `packages/shared`): `enum-parity.spec.ts` | U |
| MIG6 | Сумісність зі старим кодом після M1–M2 (вставка `Loan`/`Copy` без нових колонок) | DB |
| MIG7 | Post-migration SQL-перевірка інваріантів на копії реальної dev-БД (кількість `Copy`/`Loan` до/після) | M/runbook |
| CT1 | Схеми `packages/shared` (zod) для всіх нових контрактів, включно з відмовою на зайві поля | U |
| CT2 | Усі нові маршрути під `/api/v1` і повертають `code` у помилках | E |

Загальні команди верифікації кроку: `pnpm --filter @bookswap/api {lint,typecheck,test,test:db}`,
`pnpm --filter @bookswap/shared test`, `pnpm --filter @bookswap/web {lint,typecheck,test}`,
`pnpm --filter @bookswap/api exec prisma migrate diff --exit-code …`, підсумково `./gate.sh` (exit 0).

## 10. Загальний Definition of Done

Етап 10 вважається виконаним, лише коли **всі** пункти — істинні й доведені тестом/командою:

1. `existing loan` створює коректний активний стан `Copy` і прозорий audit trail (E1–E8, C1–C10); жодних вигаданих request/approve-подій.
2. Гостьова позика не потребує фіктивного акаунта (GL1–GL4) **і** запобіжник D2 активний (GATE1…GATE4). Цей пункт **не знімає D2**: реальні ПД заборонені в будь-якому середовищі, а Етап 10 не позначається завершеним і beta gate не вважається виконаним, доки не виконано всі критерії §7.2 та PO письмово не зняв blocker.
3. Archive ніколи не видаляє `Loan` чи історичні факти (A1–A4, DEL4); hard delete неможливий після будь-якої loan activity (DEL1–DEL3).
4. Recovered book знову доступна без переписування минулого (REC1–REC5).
5. «Хто читав» — лише фактична передача; rejected/cancelled лишаються в activity history (H1–H5).
6. Міграція з delete-моделі не видаляє дані (MIG1–MIG7); є runbook відкату/безпечного розгортання.
7. Permission/privacy: жодного витоку alias/email в API, логи, листи, аналітику (P1–P5, I2, RET8).
8. Retention D3 працює й перевірений на граничних випадках (RET1–RET9) до вмикання функції з ПД.
9. `packages/shared` містить усі контракти; DTO валідуються в рантаймі; `any` без причин відсутні.
10. Метрики §1.2 вимірюються без ПД; `funnel:report` показує їх окремим блоком.
11. Документація (українською): README/docs/user-guide/runbook відповідають поведінці; статус Етапу 10 у roadmap оновлює PO.
12. `./gate.sh` — exit 0; нічого не закомічено/не запушено автоматично.
13. **Етап 8 і beta gate не позначені завершеними**; Android Chrome QA — `NOT RUN`.

## 11. Ризики й відкриті питання

### 11.1 Відомі ризики

| ID | Ризик | Пом’якшення |
|---|---|---|
| R1 | Змінення nullable `borrowerId/currentHolderId` зачіпає багато читачів (digest, mapper-и, view-фільтри Prisma `not` виключає `NULL`) | Крок 10a робить читачів nullable-safe **до** появи `NULL`; тести P4, регресія бібліотеки |
| R2 | Примірники з історією, вже втрачені старим cascade-delete, не відновлюються | Лише backup; зафіксовано в §6.13 |
| R3 | `LOST` як «закриття» D3: власник втрачає запис, хто тримає книжку, через 90 днів | Q3; UI-застереження |
| R4 | `Invitation.recipientEmailHash` — довготривалий похідний ідентифікатор гостя (Етап 9 не чистить інвайти) | Q5 |
| R5 | Інтервальний планувальник не працює в serverless; бекап-restore повертає стерте | Q1; runbook-крок «run() після restore» |
| R6 | `ExternalBorrower.ownerId` + cascade на видалення акаунта (Етап 13) | не будувати в Етапі 10; зафіксувати як відкрите в Етапі 13 |
| R7 | Тригер immutability на `LoanEvent` ускладнить cleanup і Етап 13 | лише application-level append-only |
| R8 | Запис із прострочним `dueAt` викликає `LOAN_OVERDUE` при першому дайджесті | UI попереджає; це очікувано (Q6 про expiry) |
| R9 | Розбіжності зі spec (§5) — кроки без оновленого spec чи явного рішення PO суперечитимуть CLAUDE.md | Gate Q13 |
| R10 | Веб-клієнти старого контракту: `DELETE` тепер 409, `works/:id/history` вужчий | Оновлення web у тих самих кроках; контрактні тести S1/S2 |
| R11 | Юридичні ризики D2; запобіжник не виявляє реальних ПД поза production | §7: реальні ПД заборонені скрізь до зняття D2; запобіжник — лише допоміжний |

### 11.2 Відкриті питання до Product Owner

Питання зібрано в підсумковому звіті цього кроку; тут — канонічний перелік.

- **Q0.** ~~Назвати гілку реалізації~~ — **затверджено**: `codex/stage-10-real-world-history` (§0.2).
- **Q1.** Хто виконує retention-чистку: інтервальний сервіс у API (рекомендовано), CLI+зовнішній
  scheduler? Яка ціль розгортання API (serverless чи довгоживучий процес)?
- **Q2.** Скільки зберігати контакт **без жодної позики**? (Рекомендація: 90 днів від створення.)
- **Q3.** Чи `LOST` є «закриттям позики» для 90-денного строку D3?
- **Q4.** Що таке «завершення сценарію запрошення» для видалення email: (i) одразу після відправки
  (рекомендовано — тоді email не зберігається зовсім), чи (ii) після прийняття/строку/відкликання інвайту?
- **Q5.** Що робити з `Invitation.recipientEmailHash` гостя після завершення запрошення (обнулити після
  вікна ліміту чи лишити)?
- **Q6.** Чи потрібне автозакінчення непідтвердженого запису (`PENDING_CONFIRMATION`)? Без нього
  примірник «висить» у `RESERVED`, доки власник не відкличе. (Це новий планувальник — за
  CLAUDE.md не будується без рішення.)
- **Q7.** Чи входить прив’язка контакту до акаунта (D5) у Етап 10, чи це наступний етап? І політика
  активної гостьової позики в момент прив’язки.
- **Q8.** ~~Чи `LOST` — «читав»?~~ — **затверджено PO** (§0.3): так, лише за наявності `handedAt`.
- **Q9.** Чи рахувати записані існуючі позики в North Star/кроках funnel, чи лише окремим блоком
  (рекомендовано окремо)?
- **Q10.** ~~Модель тримача книжки~~ — **затверджено T1-a** (§0.2).
- **Q11.** ~~Чи потрібне відновлення з архіву? Чи потрібен audit `archivedAt`?~~ — **затверджено PO** (§0.4): `restore` є, окремого audit archive/restore немає.
- **Q12.** Що саме означає «виправлення» в D6 **після** підтвердження? У плані — лише до відповіді та
  через «відмова → новий запис»; правка підтвердженої позики потребує окремого рішення.
- **Q13.** ~~Gate зі специфікацією~~ — **вирішено** для розбіжностей §5: roadmap і цей план мають
  пріоритет над spec (§0.2); spec не змінюється. Нові розбіжності поза §5 потребують нового рішення.
- **Q14.** Внести «D2 відкрито» до release gate Beta в roadmap (правило roadmap §6.4); підтвердити, що
  реальні ПД заборонені в усіх середовищах до зняття D2.

D2 **не вирішено** цим планом.
