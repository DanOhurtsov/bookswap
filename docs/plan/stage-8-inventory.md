# Етап 8b–8h — inventory activation

**Статус:** 8b (архітектурна межа wizard), 8c (швидке послідовне додавання), 8d
(barcode/camera scan) і 8e (correction schema/audit, permissions/API та UI)
завершені й у main. 8f-1 (CSV parser і import persistence) теж у main; там
само — додаткові fallback-провайдери ISBN lookup (Open Library → Google Books →
ISBNdb), на які спирається 8f-2. 8f-2 (batched preview API) реалізований на
гілці `codex/8f2-import-preview-api` і чекає на рев'ю; 8f-3 (preview UI),
8g (atomic import commit) і 8h (onboarding і закриття етапу) ще не розпочаті.

**Передумова:** Етап 8a (product analytics) завершено.

**Джерело пріоритету:** `docs/plan/roadmap-v2.md`, Етап 8.

**Scope:** швидке послідовне додавання, barcode/camera scan, виправлення metadata,
CSV import і onboarding до перших 10 книг.

Цей документ закриває два відкриті рішення roadmap для Етапу 8: точний CSV
format і права на виправлення спільного каталогу. Після затвердження він є єдиним
execution plan для незавершеної частини Етапу 8.

---

## 1. Product outcome і порядок пріоритетів

Користувач може перетворити фізичну полицю на usable library без повторного
заповнення тих самих форм і без страху створити невідомо що:

1. після першої книги одразу додає наступну або ще один примірник;
2. сканує ISBN камерою, але завжди має ручний fallback;
3. бачить і виправляє metadata до та після додавання;
4. імпортує до 200 позицій через preview і один atomic commit;
5. розуміє прогрес до перших 10 книг і переходить до запрошення друзів.

Порядок реалізації визначає ризик, а не видимість функції: спочатку безпечна
архітектурна межа, далі швидкий repeat-add і scanner, потім metadata correction,
без якої не можна випускати CSV, після цього import і onboarding.

Метрики вже пишуться як `BOOK_ADDED.method = MANUAL | BARCODE | CSV`. Операційний
стан UI (`ownedCopyCount`) береться з доменних даних, а не з best-effort analytics.

## 2. Підтверджений baseline кодової бази

- `apps/web/app/(pages)/catalog/new/page.tsx` — 1282-рядковий Client Component,
  який містить увесь wizard, локальний стан, запити й усі кроки. Це суперечить
  feature-first і thin-route правилам `docs/CONVENTIONS.md`.
- Наявний wizard уже підтримує три шляхи: existing Edition; existing Work →
  Translation/Edition; new Work → Translation/Edition. ISBN запускає паралельно
  `/catalog/search/candidates` і `/catalog/lookup`.
- `POST /me/library` створює рівно один фізичний `Copy`; це правильний доменний
  контракт і він не отримує поле `quantity`.
- `Work` і `Edition` мають `createdById`; `Translation` не має автора створення.
  Жодної глобальної admin-role у системі немає.
- `Work`, `Translation` і `Edition` не мають optimistic-concurrency revision та
  історії змін.
- Open Library provider виконує single-ISBN lookup; import не повинен викликати
  його або БД послідовно для кожного рядка.
- `useWork` (`apps/web/app/lib/use-catalog.ts`) читає Work окремо від
  `useApiResource`: власний `useState`/`useEffect`/nonce цикл, і його `reload()` —
  `() => void`, не `Promise<void>` (на відміну від `useApiResource.reload()`).
  Наслідки для correction — R12.

## 3. Зафіксовані рішення

### R1. Межа web feature

Перед новою поведінкою wizard переноситься до
`apps/web/features/catalog/add-book/**` без зміни UX. Route `page.tsx` стає Server
Component приблизно до 50 рядків, а найнижча інтерактивна межа експортується з
`index.client.ts`. Server/client exports не змішуються, `export *` не з'являється.

Розбиття робиться малими behavior-preserving PR, а не одним механічним diff на
1282 рядки. Усі витягнуті й нові форми використовують React Hook Form + shared
Zod schema; server state не дублюється через `useEffect`/`useState`.

### R2. Barcode scanner і privacy

- Адаптер використовує `@zxing/browser`, завантажений dynamic import лише після
  натискання «Сканувати». Нативний `BarcodeDetector` не є production dependency:
  API експериментальний і має обмежену browser availability.
- Камера стартує тільки після user gesture через `getUserMedia` з
  `facingMode: { ideal: 'environment' }`; feature доступна лише в secure context
  (`https` або `localhost`).
- Декодується EAN-13. Значення проходить ту саму `normalizeIsbn13` і Zod-валідацію,
  що ручне введення, а потім той самий candidates + lookup flow.
- Відеокадри не завантажуються, не зберігаються й не логуються. Усі
  `MediaStreamTrack` зупиняються після успіху, cancel, error, unmount і navigation.
- Ручне поле ISBN завжди видиме. Denied permission, відсутня камера, timeout і
  unsupported browser дають зрозумілий fallback, а не dead end.

### R3. Джерело `BOOK_ADDED`

Shared `AddCopyRequest` отримує optional `entryMethod: 'MANUAL' | 'BARCODE'` із
default `MANUAL` на API. Сервер записує analytics після створення Copy. Значення не
є permission-рішенням; воно лише класифікує activation channel.

CSV не викликає `POST /me/library` для кожного рядка: import service створює Copy
у спільній транзакції та сам записує `method: 'CSV'` після її коміту.

### R4. Exact CSV v1 contract

Файл — UTF-8 CSV за RFC 4180, з optional UTF-8 BOM. Приймається comma або semicolon,
визначений за header; mixed/ambiguous delimiter відхиляється. Header обов'язковий,
порядок фіксований, невідомі/дубльовані колонки й рядки іншої довжини — помилка.

```csv
isbn13,title,authors,orig_lang,first_pub_year,edition_lang,translator,translation_source_lang,translation_year,is_abridged,has_notes,translation_notes,publisher,edition_year,page_count,cover_url,format,condition,visibility,note,acquired_at,quantity
```

Правила:

- `isbn13` обов'язковий у кожному рядку й після нормалізації має бути ISBN-13;
- `quantity` — integer `1..20`, default `1`; total copies в import — максимум 500;
- `authors` — імена через `|`, усі з роллю `AUTHOR`; literal `|` у v1 не
  підтримується;
- `orig_lang`, `edition_lang`, `translation_source_lang` — чинні ISO 639-1 коди;
- `first_pub_year`, `translation_year`, `edition_year` і `page_count` проходять
  чинні shared limits; `acquired_at` — `YYYY-MM-DD`;
- boolean — тільки `true`/`false`; `format`, `condition`, `visibility` — чинні
  enum values; defaults: `PAPERBACK`, `GOOD`, `FRIENDS`;
- catalog-поля optional, якщо ISBN уже однозначно резолвиться. Для нового catalog
  chain після lookup вони мусять утворити валідні Work/Translation/Edition дані;
- якщо `edition_lang != orig_lang`, потрібні дані перекладу або ручне рішення;
- однаковий ISBN дозволений через `quantity`; повторений нормалізований рядок у
  тому самому файлі має `DUPLICATE_ROW` і не підсумовується непомітно.

Шаблон `/library-import-template.csv` зберігається у web assets. Contract test
читає реальний asset тим самим parser і гарантує рівність header зі shared
константою. Максимум: 200 data rows і 48 KiB UTF-8 content; більший файл
відхиляється до parse. Raw CSV і приватна `note` не потрапляють у logs/analytics.

### R5. Parse, preview і commit

Сервер парсить через `csv-parse` з `bom: true`, `columns` із fixed header,
`relax_column_count: false`, `skip_empty_lines: true`, без implicit casts і з
`max_record_size`. Після синтаксису кожне поле проходить shared Zod schema.

`POST /me/library/imports/preview` не створює Work, Translation, Edition або Copy.
Він повертає draft та для кожного рядка один статус:

- `READY_EXISTING_EDITION` — точний ISBN уже є;
- `READY_CREATE_CHAIN` — lookup/candidate resolution однозначні й даних досить;
- `NEEDS_REVIEW` — неоднозначний кандидат або бракує metadata;
- `INVALID` — стабільні validation errors;
- `SKIPPED` — користувач явно пропустив рядок.

Commit дозволений лише коли кожен рядок `READY_*` або `SKIPPED`. Він виконує всі
catalog mutation і Copy inserts в одній Prisma transaction: або весь import
комітиться, або доменні дані не змінюються. Зовнішніх HTTP-викликів у транзакції
немає. Після коміту `BOOK_ADDED/CSV` записується для кожного створеного Copy за
best-effort моделлю Етапу 8a.

### R6. Safe rerun, storage і retention

Нова `LibraryImport` має unique `(ownerId, sourceHash)`, де `sourceHash` — SHA-256
нормалізованого UTF-8 content без BOM. Це opaque/pseudonymous equality key, не
анонімізація.

- Preview того самого файла повертає чинний draft або завершений summary.
- Commit бере import row lock і перевіряє статус усередині transaction.
- Повторний commit уже завершеного import повертає попередній success response й
  не створює нові Copy.
- Draft rows живуть 24 години; прострочення очищається lazy під час наступного
  preview/get, без scheduler.
- Після commit payload рядків видаляється. `LibraryImport` зберігає hash, статус,
  counts і timestamps для idempotency; сирий файл не зберігається.

Користувач із реальною другою фізичною копією використовує `quantity`, repeat-add
або новий файл зі зміненим content. Кнопки «імпортувати ще раз попри той самий
hash» у Stage 8 немає.

#### R6a. Погоджені рішення 8f-1 (PO, 2026-09-17)

Закривають питання, які R4–R6 і §4 залишали відкритими для parser і persistence.

**Файл і синтаксис (R4/R5).**

- Ліміт 48 KiB перевіряється за початковим розміром отриманого файла, включно з BOM,
  до decode і parse.
- Початковий UTF-8 BOM знімається рівно один раз, до decode; `csv-parse` отримує
  `bom: false`. Другий BOM не зникає непомітно: header не збігається
  (`HEADER_MISMATCH`). Невалідний UTF-8 — `INVALID_ENCODING`.
- Header перевіряється раніше за порожнечу: файл лише з header (зокрема шаблон)
  дає `EMPTY`, а не `HEADER_MISMATCH`. Шаблон `/library-import-template.csv`
  містить лише header, без демонстраційної книги; приклад заповнення — у
  документації, не в asset.
- `max_record_size` дорівнює 48 KiB — суто захисне значення: запис не може мати
  більше символів, ніж файл байтів, тож жоден дозволений R4 рядок ним не
  відхиляється. Окремого продуктового ліміту на рядок і окремого reason немає.
- Рядки розділяються `\r\n`, `\n` або `\r`, зокрема змішано в одному файлі;
  порожні рядки пропускаються. `rowNumber` — порядковий номер data record
  (1-based), а не фізичний рядок файла.
- Клітинка рівно `''` означає «не задано» (для `quantity` — 1, для `format`,
  `condition`, `visibility` — defaults R4). Будь-яке інше значення проходить
  чинну shared-схему поля без додаткових перетворень. Integer — лише
  `0|-?[1-9][0-9]*` без пробілів; boolean — лише `true`/`false`.

**DUPLICATE_ROW (R4).** Ключ — усі нормалізовані значення рядка (після shared Zod,
з defaults), крім `quantity`. Порядок авторів — частина ключа; автори за іменем не
об'єднуються; жодної нормалізації тексту поза shared-схемами (Unicode NFC теж ні).
Перше валідне входження лишається, наступні отримують `DUPLICATE_ROW` з
`firstRowNumber`. Quantity дублікатів не підсумовується. Рядки з помилками полів у
порівнянні не беруть участі. Правила «DUPLICATE_ROW можна лише пропустити» немає.

**500 Copy на етапі parse.** Сумуються валідні `quantity` УСІХ рядків, включно з
`DUPLICATE_ROW` і рядками з іншими помилками; порожнє `quantity` = 1. Невалідне
`quantity` не замінюється одиницею: рядок отримує помилку, а його кількість у суму
не входить. Проходження цього ліміту не доводить готовності до commit: після
edit/resolve (8f-2) кількість перераховується, а перед commit (8g) максимум 500
Copy повторно перевіряється за фактичними непропущеними валідними рядками.

**sourceHash (R6).** SHA-256 від отриманих UTF-8 байтів після видалення лише
початкового BOM. CRLF/CR, Unicode, пробіли й delimiter не нормалізуються: той самий
вміст з іншими закінченнями рядків — інший `sourceHash`.

**Expiration і повторний preview (R6).**

- Статуси `LibraryImport`: `DRAFT`, `EXPIRED`, `COMMITTED`.
- Прострочений draft стає `EXPIRED`: усі `LibraryImportRow` (payload із приватною
  `note`) видаляються атомарно зі зміною статусу, metadata (hash, counts,
  timestamps) лишається. Cleanup lazy і scoped до owner, без scheduler.
- `EXPIRED` відновлюється лише з повторно наданого й перевіреного файла: нові rows
  і новий TTL у тому самому записі. `COMMITTED` не відновлюється, не скидається й
  не прострочується — завжди повертає попередній summary.
- Два одночасні перші збереження того самого owner/hash: транзакція, що програла
  на unique `(ownerId, sourceHash)`, повністю відкочується; повтор виконується
  новою транзакцією вже після rollback. Результат — один import і один комплект rows.
- HTTP-поведінка (`IMPORT_EXPIRED`, `404` для чужого id) — 8f-2.

**Помилки рівня файла (§4).** Структурно зламаний CSV — `IMPORT_INVALID_CSV` з
`details.reason`: `HEADER_MISMATCH` (`missingColumns`, `duplicateColumns`,
`unknownColumnPositions` — лише позиції, без тексту файла, `orderMismatch`),
`AMBIGUOUS_DELIMITER`, `COLUMN_COUNT` і `MALFORMED_CSV` (з `line`),
`INVALID_ENCODING`, `EMPTY`. Перевищення лімітів — `IMPORT_TOO_LARGE` з
`details: { limit: BYTES | ROWS | COPIES, max, actual }`.

### R7. Batched catalog resolution

Preview спочатку одним запитом отримує всі локальні Edition за ISBN. Cache hits
ISBN lookup також читаються batch. Missing ISBN групуються у bounded provider
requests по максимум 50 bibkeys; Open Library adapter розширюється `lookupMany`,
але зберігає той самий normalizer/cache contract. Згідно з актуальними правилами
провайдера production додає ідентифікований `User-Agent` із contact email, а
missing config не маскується дефолтною персональною адресою.

Для нових ISBN кандидатів Work шукає один batched resolver, а не `await` у циклі:
SQL `VALUES`/CTE з row key і lateral top-N reuse чинного trigram/ranking contract.
Жодних N+1 для Edition, candidate, Work, Translation чи author hydration.

External timeout/partial provider failure не перетворюється на «книгу не знайдено»:
рядок отримує retryable error, а draft лишається без domain writes.

#### R7a. Погоджені рішення 8f-2 (PO, 2026-09-18)

Закривають питання, які R4–R7 і §4 залишали відкритими для preview API.

**Передача файла.** CSV приїжджає як base64 у JSON:
`POST /me/library/imports/preview` приймає `{ contentBase64 }` — strict shared
Zod-схема плюс DTO з parity-тестами (§4). Байти доходять до парсера такими, як
їх надіслали, тож байтові правила R6a (48 KiB разом із BOM ДО decode,
`INVALID_ENCODING`, `sourceHash`) лишаються перевірними. Коректність base64
перевіряється ДО декодування — рівно стандартний padded-алфавіт, без `data:`,
пробілів і переносів: `Buffer.from` мовчки викидає те, чого не розуміє, і
пошкоджений запит декодувався б у КОРОТШИЙ файл з іншим hash. Невалідний base64
— `VALIDATION_ERROR`; невалідний UTF-8 — `IMPORT_INVALID_CSV/INVALID_ENCODING`;
перевищення — `IMPORT_TOO_LARGE/BYTES`. Транспортна межа тіла свідомо вища за
48 KiB, щоб трохи більший файл дійшов до парсера й дістав чесний розмір у
`details.actual`, а не глухе 413 від body-parser'а.

**Fallback у batch lookup.** Порядок: локальні `Edition` → кеш → Open Library
`lookupMany` пакетами по 50 bibkeys → одиночні провайдери. `lookupMany`
розрізняє три випадки, і третій принциповий: bibkey, якого немає у відповіді, —
це «немає запису»; bibkey, який є, але чий запис не читається, — помилка САМЕ
цього ISBN. Решта batch при цьому зберігається. Така помилка передається далі й
може бути компенсована успішним fallback; якщо fallback теж нічого не знайшов,
рядок лишається `LOOKUP_UNAVAILABLE`, а не стає `LOOKUP_NOT_FOUND`, і в
негативний кеш не записується. Google Books і
ISBNdb batch API не мають, тож для них діє бюджет: максимум 50 УНІКАЛЬНИХ ISBN
на один preview, паралельність 4. Бюджет рахує ISBN, а не HTTP-виклики (два
провайдери — до вдвічі більше запитів); повторений ISBN бюджету вдруге не
витрачає; порядок — за першим входженням, тож той самий файл резолвить ті самі
рядки. Рядки поза бюджетом отримують `LOOKUP_UNAVAILABLE` з
`reason: BUDGET_EXHAUSTED` і `retryable: true`, ніколи не `LOOKUP_NOT_FOUND`.
Batch-шлях НЕ будується на `FallbackBookLookupProvider`: той повторно питав би
Open Library і на кожен результат робив би окремий Work-enrichment-пошук —
прихований N+1. `LOOKUP_NOT_FOUND` допустимий лише після завершеного пошуку в
усіх провайдерах; успіх пізнішого провайдера скасовує збій попереднього.
Одиночний `GET /catalog/lookup` і ручне додавання книги не змінюються.

**Повтор resolution.** `PATCH .../rows/:rowNumber` має дію `RETRY`: вона
переганяє resolution збереженого рядка й повертає весь перерахований draft.
Повторний `POST preview` того самого файла лишається ідемпотентним за R6 —
чинний draft повертається недоторканим і не витрачає жодного зовнішнього
виклику. Дії рядка: `EDIT`, `CHOOSE`, `SKIP`, `RESTORE`, `RETRY` (discriminated
union; поле чужої дії відхиляється, а не зрізається).

**Кандидати.** Навіть ОДИН схожий `Work` робить рядок `NEEDS_REVIEW` з
`AMBIGUOUS_CATALOG_MATCH`: автовибір тезки помітити й відкотити важче, ніж
відповісти на одне питання. Користувач явно обирає наявний `Work` або `null` —
«створити новий». `workId`, якого рядку не пропонували, — 400 без запису; вибір,
що перестав бути кандидатом (merge, зміна рядка), не тягнеться далі, а рядок
питає знову. Нуль кандидатів сам по собі НЕ дає `READY_CREATE_CHAIN`: потрібні
ще повні валідні дані `Work/Translation/Edition`, інакше —
`MISSING_CATALOG_DATA`.

**Мова оригіналу й суперечливі дані (PO, 2026-09-18).** `orig_lang` береться
ЛИШЕ з файла. `language` провайдера описує видання в руках, не твір, а
`edition_lang` не є доказом мови оригіналу: українське видання не означає, що
твір написано українською. Для нового `Work` невідома мова оригіналу — це
`MISSING_CATALOG_DATA`, а не привід вгадати.

Явно задані translation-поля не відкидаються мовчки. Якщо мова видання збігається
з мовою оригіналу, а рядок водночас називає перекладача (або інший факт про
переклад), це `CONFLICTING_CATALOG_DATA` з переліком колонок: рядок —
`NEEDS_REVIEW`, `resolution = null`, commit заблоковано до виправлення або skip.
Boolean враховується лише як `true`: `is_abridged=false` однаково правдиве для
оригіналу й нічого не стверджує. Три коди розрізняються за змістом:
`INVALID_FIELD` — неправильне значення поля, `MISSING_CATALOG_DATA` — бракує
даних, `CONFLICTING_CATALOG_DATA` — значення валідні окремо, але їхня комбінація
потребує рішення. Глобальної заборони однакових мов у `Translation` це не
вводить: перевірка стосується неоднозначного CSV, не доменних правил каталогу.

**Конкурентні PATCH: `expectedRowVersion` (PO, 2026-09-18).**

Блокування рядка `LibraryImport` і винесення зовнішніх викликів за межі
транзакції — необхідні, але НЕ достатні. Lock лише вишиковує операції в чергу;
він не робить другу з них слушною. Конкретний випадок, який це показує: `RETRY`
чекає на провайдера, власник тим часом пропускає рядок, `RETRY` повертається й
застосовується до вже пропущеного рядка — skip мовчки скасовано. Кеш за ключем
ISBN тут теж не рятує: скасування робить не результат lookup, а сама дія над
рядком.

Тому кожен рядок несе `rowVersion` — непрозорий токен, що ідентифікує САМЕ цей
його стан:

- `preview`, `GET` і `PATCH` повертають `rowVersion` для кожного рядка;
- кожен `PATCH` передає `expectedRowVersion` — обов'язково для ВСІХ дій,
  зокрема тих, що не ходять до провайдера: питання в тому, який рядок мала на
  увазі людина, а не скільки тривав запит;
- сервер звіряє його двічі: перед зовнішнім викликом (щоб застаріла операція не
  витрачала чужу квоту) і повторно під lock безпосередньо перед записом;
- розбіжність — `409 IMPORT_ROW_CONFLICT`, нічого не записано, без
  автоматичного повтору. Тіло помилки не містить вмісту чернетки; клієнт
  перечитує draft і повторює дію явно;
- успішна явна дія над рядком мінтить йому нову версію. Технічне перезаписування
  всіх рядків і перерахунок похідного стану (статуси, дублікати, readiness)
  версій ІНШИХ рядків не змінюють — тому `SKIP` рядка 1 і `EDIT` рядка 2
  паралельно обидва успішні;
- expiry → revive мінтить нові версії навіть за побайтово того самого файла:
  стара чернетка прострочилась, і операція, ухвалена на ній, до нової не
  належить.

Версія — не порівняння payload, не hash вмісту й не `updatedAt`: послідовність
A → B → A мусить конфліктувати з операцією, що читала перше A. Зберігається
разом із рядком у його payload, тож міграція для 8f-2 не потрібна. Перевірки
expired / committed / чужої чернетки лишаються чинними — `rowVersion` їх не
замінює.

**Ліміт 500 копій після редагування.** Parse-time перевірка R6a лишається без
змін. Живий `readiness.copyCount` рахується за рядками, які реально
комітитимуться, і МОЖЕ перевищити 500 — наприклад, коли виправлено рядок із
невалідним `quantity`, що на parse не рахувався взагалі. Тоді повертається
справжнє число і `canCommit: false`, а не підрізане до ліміту.

### R8. Права на catalog correction

Глобальна admin-role не додається. Автентифікований користувач може змінити:

- `Work`, якщо `Work.createdById == userId` або він володіє Copy будь-якого Edition
  цього Work;
- `Edition`, якщо `Edition.createdById == userId` або він володіє Copy цього
  Edition;
- `Translation`, якщо `Translation.createdById == userId` або він володіє Copy
  Edition, що посилається на цю Translation.

Перевірка виконується в API одним permission query всередині mutation flow. Право
володіння — поточне; воно не дає права видаляти, merge або переносити сутність до
іншого Work. Інші користувачі отримують `403 CATALOG_EDIT_FORBIDDEN`.

### R9. Audit і optimistic concurrency

`Work`, `Translation`, `Edition` отримують `revision Int @default(1)`;
`Translation` також `createdById` і `createdAt`. Existing Translation backfill бере
`Work.createdById`; `createdAt` для старих рядків дорівнює часу міграції й не
видається за історичну дату. Після backfill creator field стає required.

Кожен PATCH передає `expectedRevision`. Conditional update збільшує revision;
застарілий клієнт отримує `409 CATALOG_REVISION_CONFLICT` і свіжу сутність для
повторного рішення, без silent overwrite.

Immutable `CatalogRevision` зберігає `entityType`, `entityId`, nullable actor з
`onDelete: SetNull`, before/after JSON, from/to revision і `createdAt`. Він не має
FK до catalog entity, щоб пережити майбутній merge. Update і audit insert — одна
transaction. UI не потребує public audit endpoint у Stage 8.

**Погоджена повнота `before`/`after` (закриває прогалину, яку 8e-1 виявив при
першому написанні тестів на ці схеми).** Знімок — це ПОВНІ редаговані metadata
сутності, не довільне підмноження: кожне поле, яке PATCH цієї сутності може
змінити, має власне поле у відповідній `*RevisionSnapshotSchema`
(`catalog-correction.ts`) і навпаки — жодне патчабельне поле без пари в
знімку. Для Work це поширюється і на `authors`: кожен елемент несе не лише
`authorId`/`name`/`role`/`position` (R10a), а й `nameLatin` — поле, яке
дозволяє задати саме author input (R10), і яке перше чернетка схеми
пропустила. `nameLatin` у знімку — `nullable`, не `optional`: авторський
запис або має транслітерацію, або явно `null`, а не «поле відсутнє».
Прямий regression-тест цієї відповідності — `catalog-correction.spec.ts`
(`packages/shared`), а не лише читання схеми очима.

### R10. Дозволені metadata fields

- Work: `title`, `origLang`, `firstPubYear`, `description`, повний список
  `authors` (наявний `authorId` або нове `name`, роль і порядок елементів масиву).
  `position` обчислює сервер за цим порядком, а не приймає окремим полем запиту.
  Заміна зв'язків не видаляє Author rows.
- Translation: `translator`, `lang`, `sourceLang`, `year`, `isAbridged`,
  `hasNotes`, `notes`.
- Edition: `publisher`, `year`, `isbn13`, `pageCount`, `coverUrl`, `format` і
  `translationId`, але Translation мусить належати тому самому Work.

Не редагуються `workId`, `createdById`, merge fields, rating aggregates, Copy/Loan
через catalog PATCH. Author як глобальна сутність не перейменовується. ISBN unique
conflict і merged Work лишають чинні canonical/error semantics.

`WorkDetailResponse` додає `viewerCapabilities` (`canEditWork`,
`editableTranslationIds`, `editableEditionIds`), щоб UI не вгадував permissions.

#### R10a. Порядок авторів: create, correction, backfill і merge

Ручний порядок авторів входить у scope 8e. Це погоджена цільова поведінка, а не
опис уже реалізованої можливості.

- `position` належить зв'язку `WorkAuthor`, не глобальному `Author`. Для всього
  списку одного Work позиції утворюють послідовність `0, 1, 2, …` без пропусків і
  повторів; нумерація не починається заново для кожної ролі. Роль зберігається
  окремо й не перевизначає ручний порядок.
- У create Work і при заміні `authors` через PATCH єдине джерело порядку —
  порядок елементів масиву. Сервер сам призначає `position`; клієнт не передає
  паралельну нумерацію. Чинний вибір `authorId` або нового `name` зберігається:
  перестановка не перейменовує глобальний Author і не об'єднує тезок за ім'ям.
- Ідентичність зв'язку лишається парою `authorId + role` у межах Work. Один Author
  у різних ролях може мати окремі позиції; `position` не замінює цю ідентичність.
- Для старих зв'язків backfill відтворює нинішній видимий порядок мапера:
  `AUTHOR → CO_AUTHOR → EDITOR → ILLUSTRATOR`, далі порівняння імен українською
  (`localeCompare(..., 'uk')`), при рівності — стабільний порядок за `authorId`.
  Історичний порядок введення не вигадується. Відповідність backfill цьому
  компаратору перевіряється на legacy-даних; не можна мовчки підмінити його
  сортуванням за default collation БД.
- При merge спочатку лишається весь список target у його порядку, потім
  додаються відсутні на target пари `authorId + role` у порядку source.
  Дубль зберігає позицію target; підсумкові позиції — послідовні від нуля.
  Консолідація і запис позицій відбуваються в тій самій merge-транзакції;
  правила збереження Author, canonical Work і rollback не змінюються.
- У відповідях каталогу автори повертаються за `position`, із цим полем у
  shared response contract. Після backfill читання більше не пересортовує їх
  за роллю або ім'ям.

**Погоджені правила `authors` у `PATCH /works/:id` (закривають прогалину, яку
8e-1 виявив при написанні DTO/Zod parity-тестів — раніше тут була
незафіксована розбіжність між `class-validator` і zod, а не свідоме рішення):**

- **omitted** (ключа `authors` немає в тілі) — Work-автори без змін;
- **`authors: null`** — заборонено (400): `null` — це не «омітед», а явне
  значення там, де zod лишає лише `| undefined`;
- **`authors: []`** — заборонено (400): Work без жодного автора не є валідним
  станом ні при створенні, ні після правки (`CATALOG_LIMITS`, `.min(1)`);
- **`authors: [...]`** — повна заміна списку за R10a: сервер сам призначає
  `position` за порядком елементів, тож жоден елемент НЕ приймає власне поле
  `position` — воно відхиляється як невідоме (як і будь-яке інше невідоме
  поле елемента), а не мовчки зрізається;
- усередині елемента `authorId`/`name`/`role` — опційні, але НЕ nullable:
  `null` на будь-якому з них відхиляється так само, як і на верхньому рівні
  Work/Translation/Edition PATCH; `nameLatin` — єдиний виняток, опційний І
  nullable (`null` — «прибрати транслітерацію»). **Це стосується лише
  елемента з новим `name`** (створення нового Author). `nameLatin`, переданий
  разом із `authorId` наявного автора, НЕ є дозволом відредагувати
  транслітерацію глобального `Author` через список авторів Work — R10 вище
  вже забороняє перейменування Author через catalog PATCH, і те саме правило
  поширюється на `nameLatin`: `Author` — спільна сутність для всіх Work, що на
  неї посилаються, і правка метаданих одного Work не має права мовчки міняти
  її для решти. Вибір за `authorId` бере `name`/`nameLatin` наявного автора
  такими, які вони вже є в базі. **PO-рішення (закриває вибір, залишений
  8e-1 відкритим для 8e-2):** `authorId` + `nameLatin` разом на одному
  елементі — 400, навіть якщо `nameLatin: null`. Реалізовано і на zod
  (`authorIdExcludesNameLatin`, `catalog-correction.ts`), і на
  class-validator (`EachAuthorIdExcludesNameLatin`, `common/validators.ts`)
  — обидва PATCH-only (`WorkAuthorInputDto`/`workAuthorInputSchema` для
  CREATE лишаються незмінними), без нового error code: помилка йде як
  звичайний `VALIDATION_ERROR`/400 глобального `ValidationPipe`/zod-парсингу,
  як і решта правил цього PATCH;
- невідоме поле верхнього рівня самого PATCH-тіла (Work/Translation/Edition)
  теж відхиляється, а не зрізається — на відміну від CREATE-контрактів
  (`createWorkRequestSchema` тощо), чия поведінка тут навмисно НЕ змінена
  (`catalog.dto.spec.ts` документує цю відмінність явно, а не мовчки).

Обидва механізми (`workPatchRequestSchema`/`translationPatchRequestSchema`/
`editionPatchRequestSchema` у `catalog-correction.ts` і відповідні
`Patch*Dto` у `catalog-correction.dto.ts`) узгоджені між собою тестами
парності (`catalog-correction.dto.spec.ts`) — жодна з цих правил не
закріплена окремо для одного боку.

### R11. Repeat-add і onboarding

Після успіху wizard показує три дії:

1. «Ще один такий примірник» — той самий Edition, новий Copy;
2. «Додати наступну книгу» — чистий search step;
3. «Сканувати наступну» — відкриває camera flow.

Для наступної книги зберігаються лише `condition` і `visibility` як session defaults;
`note` та `acquiredAt` завжди очищаються. Жодного localStorage.

`GET /me/activation` повертає `ownedCopyCount`, `target: 10`, `hasReachedTarget` і
`nextAction`. Checklist рендериться server-first у бібліотеці й після add/import;
при 10 книгах CTA веде до чинної сторінки friends. Invite links належать Етапу 9.

### R12. TD-03: TanStack Query для correction і CSV import

Загальне правило й обов'язкові вимоги реалізації зафіксовані в
`docs/CONVENTIONS.md` §3.9. Тут — лише те, що специфічне для 8e-3/8f-3.

**Хто володіє Work state.** Сторінка `apps/web/app/(pages)/works/[id]/page.tsx`
сьогодні читає Work/Translation/Edition через legacy `useWork`
(`apps/web/app/lib/use-catalog.ts`) — окремий від `useApiResource` цикл
`useState`/`useEffect`/nonce, і саме туди приїде `viewerCapabilities` (R10) разом
із рештою `WorkDetailResponse`. 8e-3 не заводить паралельний TanStack `useQuery` на
той самий ресурс: `useWork` лишається єдиним читачем і єдиним кешем Work-даних на
цій сторінці. TanStack Query у 8e-3 керує лише мутацією (`useMutation` на
`PATCH /works/:id` / `/translations/:id` / `/editions/:id`) — pending/error станом
запиту й optimistic-патчем, який рендериться поверх значення з `useWork`, тим самим
прийомом «overlay над останнім відомим станом», що вже є в
`resource-state.ts`/`wishlist.ts`.

**`useWork` + TanStack `useMutation` в одному компоненті — вузький legacy-виняток,
специфічний саме для 8e-3, а не взірець для інших фіч.** §3.9 CONVENTIONS.md
залишає legacy-хуки без міграції; тут додатково свідомо змішуються дві різні
бібліотеки в одному екрані (читання — старою, запис — новою), бо повна міграція
читання Work на TanStack Query — це вже інша, більша задача (§3.9: «міграція —
окремі обґрунтовані задачі, не масове переписування»), а мутації Work у 8e-3
потрібні вже зараз.

Після успішного PATCH форма викликає `reload()` з `useWork`, а не
`invalidateQueries` на ключ Work — інвалідація TanStack cache нічого не зробить із
даними, які показує legacy-хук, бо кеш не спільний.

**Погоджений механізм awaitable `reload` (закриває нестиковку, залишену
відкритою вище).** `useWork().reload` — `() => Promise<WorkReloadOutcome>`, де

```ts
type WorkReloadOutcome =
  | { status: 'success' }
  | { status: 'error'; message: string }
  | { status: 'cancelled' }
```

Реалізовано власним generation+waiter механізмом усередині `useWork`
(`use-catalog.ts`), а не переїздом на `useApiResource` і без зміни
`use-resource.ts`: кожен виклик `reload()` завершується відповідно до СВОГО
запиту, а не запиту, який його випередив.

- **`success`** — відповідний GET дістав і прийняв свіжий знімок (не лише
  «проміс резолвився»): дані вже записані в `state`.
- **`error`** — сам GET-запит на refresh не вдався (HTTP чи мережа). Помилка
  refresh ПІСЛЯ успішного PATCH не відкочує підтверджені сервером зміни й не
  показується як провал збереження — форма differencює «не вдалося зберегти»
  і «збережено, але не вдалося оновити сторінку» (`RefreshNotice` в
  `features/catalog/correction`), і не повторює PATCH, лише GET.
- **`cancelled`** — саме цей виклик не дістав відповіді: його випередив
  пізніший `reload()` (до завершення свого запиту) або компонент
  розмонтувався першим. **Не** «усиновлюється» новим поколінням (на відміну
  від `useApiResource`'s adopt-on-supersede) — це свідомий вибір: викликач
  дізнається, що саме його виклик ні на що не дочекався, а не отримує чужий
  результат під виглядом власного. Так само при зміні `workId` (навігація на
  інший твір, поки reload летить) — старий виклик резолвиться `cancelled`, а
  не показує (навіть на мить) дані книги, яку більше не показують.

Обидві вимоги вище виконані: (1) звірка revision — відповідальність
викликача (correction-форми звіряють revision саме своєї сутності зі свіжого
знімку, R9); (2) `reload()` сам ніколи не виводить «завершено» з факту
незміненої revision — три явні результати замість здогадки.

Тести: `apps/web/app/lib/use-catalog.spec.ts`.

**Один canonical query для CSV import (8f-3).** `GET /me/library/imports/:id`
повертає повний draft — summary і rows разом, за контрактом R5/R6 — і це один
query key: `['library-import', importId]`. Окремого `rows`-ендпоінта в API немає
(§4), тож окремого query key чи окремого кеша під рядки таблиця не заводить: рядки
в UI — похідне представлення того самого кешованого документа (`select` у
`useQuery`, не другий запит).

`PATCH .../rows/:rowNumber` (resolve/skip) інвалідує/оновлює саме
`['library-import', importId]` — весь draft, а не лише один рядок: відповідь
цього PATCH або наступний GET має принести й новий статус рядка, і перерахований
стан готовності до commit (чи всі рядки тепер `READY_*`/`SKIPPED`) в тому самому
об'єкті. Optimistic-патч (якщо він є) так само пише в цей один ключ, не в
паралельну структуру «лише для цього рядка» — інакше готовність до commit і
таблиця рядків можуть розійтися між двома джерелами.

`POST .../commit` інвалідує той самий `['library-import', importId]` (draft стає
завершеним summary). Жодна з цих mutations не перетинається з
`useWork`/`useApiResource` — preview і commit не мають legacy-читача цього самого
ресурсу, з яким треба узгоджуватись, тому тут немає подвійного джерела правди для
самого імпорту, на відміну від correction.

Після успішного commit власна бібліотека й activation progress повинні
відображати створені Copy. Для змонтованого legacy `useOwnLibrary` потрібне явне
перезавантаження; інвалідація TanStack Query його не оновлює. Спосіб актуалізації
server-first activation визначається в 8h відповідно до R11. Сам факт навігації не
гарантує свіжих даних — сценарій commit → актуальна бібліотека та прогрес
покривається тестом.

**Залежність і мінімальний setup.** `@tanstack/react-query` у репозиторії ще немає.
Встановлення пакета, мінімальний `QueryClientProvider` (один на клієнтську сесію,
без серверного singleton, спільного між запитами або користувачами; ізольований
request-scoped екземпляр дозволений — CONVENTIONS.md §3.9) і
тестова обгортка (`QueryClientProvider` у `jest`/`@testing-library/react`, той
самий стек, що й решта `apps/web`) плануються як перший узгоджений крок 8e-3, ПІСЛЯ
завершення 8e-2 (API готове) — не в цьому документі й не до нього. Універсальний
mutation-adapter поверх TanStack Query для всіх майбутніх фіч у 8e-3 не
проєктується: кожна фіча (correction, потім CSV rows у 8f-3) визначає власні query
keys і mutations без спільної абстракції на цьому етапі.

## 4. API і shared contracts

Нові endpoints:

| Method  | Route                                     | Призначення                         |
| ------- | ----------------------------------------- | ----------------------------------- |
| `PATCH` | `/works/:id`                              | metadata + `expectedRevision`       |
| `PATCH` | `/translations/:id`                       | metadata + `expectedRevision`       |
| `PATCH` | `/editions/:id`                           | metadata + `expectedRevision`       |
| `POST`  | `/me/library/imports/preview`             | parse/resolution, без domain writes |
| `GET`   | `/me/library/imports/:id`                 | власний draft/summary               |
| `PATCH` | `/me/library/imports/:id/rows/:rowNumber` | resolve або skip                    |
| `POST`  | `/me/library/imports/:id/commit`          | atomic idempotent commit            |
| `GET`   | `/me/activation`                          | прогрес до 10 книг                  |

Усі JSON request/response/error schemas живуть у `packages/shared`, DTO мають
parity tests. Import draft завжди scoped до owner; чужий id повертає `404`, щоб не
розкривати існування. Preview має окремий authenticated throttle (5/min/user або
еквівалентний чинній інфраструктурі), commit — 10/min і залишається idempotent.

Стабільні row errors: `INVALID_ISBN`, `INVALID_FIELD`, `DUPLICATE_ROW`,
`LOOKUP_UNAVAILABLE`, `LOOKUP_NOT_FOUND`, `MISSING_CATALOG_DATA`,
`AMBIGUOUS_CATALOG_MATCH`. Import errors: `IMPORT_TOO_LARGE`, `IMPORT_INVALID_CSV`
(R6a), `IMPORT_EXPIRED`, `IMPORT_NOT_READY`. Текст локалізує web; API повертає code і structured details.

## 5. Data model і migration safety

1. Additive migration: `revision` columns, nullable `Translation.createdById`,
   `Translation.createdAt @default(now())`, `LibraryImport`, `LibraryImportRow`,
   `CatalogRevision` та індекси.
2. SQL backfill Translation creator через parent Work, перевірка `NULL = 0`.
3. Наступний migration step робить creator field required.
4. Індекси щонайменше: import owner/hash unique, owner/status, expiresAt;
   revisions entity/id+createdAt; Translation createdById.
5. Міграція запускається на copy production-like DB і має documented rollback.

У 8e-1 також додається `WorkAuthor.position` із backfill за R10a. Після
міграції всі наявні зв'язки мають визначені позиції; чинні create/read/merge
шляхи та seed/fixtures оновлюються в тому самому підетапі, щоб нові записи не
порушували порядок. Це не дозволяє починати PATCH endpoints або correction UI.

`CatalogRevision.before/after` і draft payload валідовуються при записі та читанні;
JSON не замінює shared contract. Жодного historical backfill audit не вигадується.

## 6. Послідовність implementation PR

Кожен PR відповідає `docs/CONVENTIONS.md`, бажано близько до 400 semantic diff,
проходить root `gate.sh` і не починає наступний підетап до merge попереднього.

### 8b-1 — add-book model, transitions і shell

- Винести wizard types, pure transitions/reset helpers, shell і language field;
  route behavior не міняти.
- Додати unit tests transition/reset invariants.
- **DoD:** ті самі три шляхи wizard і наявні route tests green; route ще може бути
  client boundary. **Не робити:** scan, repeat-add, нові API.

### 8b-2 — search і candidate selection

- Винести SearchStep/CandidateCard та API adapter; form — RHF + shared Zod.
- **DoD:** title/ISBN, parallel candidates + lookup, retry й selection мають ті
  самі результати; focused component tests green.

### 8b-3 — Work і author forms

- Винести WorkStep/AuthorRow; authors — `useFieldArray`, порядок і ролі не губляться.
- **DoD:** existing/new Work branches, validation і API errors мають regression
  coverage; жодної server state копії в effect.

### 8b-4 — Translation form

- Винести TranslationStep на RHF + shared Zod.
- **DoD:** original-language skip і translation create branches не змінилися;
  nullable/boolean fields і API errors covered.

### 8b-5 — Edition і Copy forms

- Винести EditionStep та CopyStep на RHF + shared Zod.
- **DoD:** lookup-prefill лишається editable; existing Edition не створюється
  повторно; Copy defaults/date/note covered.

### 8b-6 — orchestrator і low client boundary

- Винести client wizard/orchestration у feature; зробити route Server Component
  з explicit `index.client.ts` export; перенести/розділити route tests.
- **DoD:** `page.tsx` приблизно до 50 рядків; усі три wizard paths green; initial
  bundle не містить scanner; lint/typecheck/tests/build/root gate green.

### 8c — quick sequential add

- Реалізувати три post-success actions і точні reset rules R11.
- Передати `entryMethod` і покрити API analytics integration.
- **DoD:** кілька Copy додаються без повернення до catalog; double click не створює
  випадкову копію; browser test перевіряє repeat flow і back/forward.

### 8d — barcode/camera scan

- Додати lazy scanner adapter, lifecycle cleanup і manual fallback R2.
- **DoD:** валідний scan і manual ISBN дають той самий server-resolved результат;
  BARCODE event записано; permission/error/cleanup component tests і manual mobile
  matrix (iOS Safari, Android Chrome, desktop no-camera) пройдені.

### 8e-1 — correction schema, audit і contracts

- Additive migration/backfill, shared PATCH schemas/responses/error codes.
- `WorkAuthor.position`, legacy backfill і сумісність чинних create/read/merge
  шляхів за R10a; потрібні зміни seed/fixtures і shared response contract.
- **DoD:** migration up/down strategy перевірена; DTO parity, enum parity і schema
  tests green; порядок після legacy backfill, create/read і merge (target-first,
  дубль пари, різні ролі, тезки, rollback) покрито regression-тестами.
  **Не робити:** нові endpoints/UI.

### 8e-2 — correction permissions і API

- Реалізувати PATCH transactions, permission query, revision conflict і audit.
- Заміна списку авторів зберігає заданий масивом порядок за R10a; перестановка
  зв'язків входить у ту саму correction-транзакцію з revision і audit.
- **DoD:** creator/owner/stranger, concurrent edit, unique ISBN, merged Work,
  audit atomicity та rollback покриті integration/DB tests; без N+1.

### 8e-3 — correction UI

- Перший крок: додати `@tanstack/react-query`, мінімальний `QueryClientProvider` і
  test setup — до форм, після 8e-2 (R12).
- RHF + Zod форми з capabilities, optimistic update/rollback і conflict refresh на
  TanStack Query `useMutation`; `useWork` лишається єдиним читачем Work-даних (R12).
- **DoD:** keyboard/mobile/error states перевірені; неавторизований edit control не
  показується, але API лишається остаточною межею permissions; успішний PATCH
  оновлює і власний optimistic overlay, і legacy `useWork` сторінки Work (R12).

### 8f-1 — CSV parser і import persistence

- Shared CSV contract/constants, parser, template, import models і TTL behavior.
- **DoD:** BOM, comma/semicolon, quotes/newlines, malformed/mixed headers, caps,
  duplicate rows і Unicode covered; parser fuzz cases не падають процесом.

### 8f-2 — batched preview API

- Реалізувати lookupMany, batched DB/candidate resolver і draft endpoints за
  R7 і погодженими рішеннями R7a.
- **DoD:** preview робить нуль domain writes; query-count test не росте лінійно з
  rows; provider partial failure retryable; owner isolation/rate limit green.

### 8f-3 — CSV preview UI

- Upload/template, row table, filters, errors, edit/choose/skip і resume draft на
  TanStack Query, один canonical query `['library-import', importId]` (draft +
  rows разом, R12); rows table — `select` над цим самим запитом, не окремий ключ.
- Після успішного commit явно оновити бібліотеку й (коли готовий) activation —
  legacy-читачі не бачать `invalidateQueries` (R12); координується з 8g/8h.
- **DoD:** commit disabled до повної resolution; 200 rows usable на mobile/desktop;
  private note рендериться лише як text, ніколи як HTML/formula execution.

### 8g — atomic import commit і analytics

- Transactional catalog/Copy creation, row lock, safe rerun і cleanup R5–R6.
- **DoD:** concurrent/double commit створює одну множину Copy; injected failure
  залишає нуль domain writes; quantity і 500-copy cap tested; кожен Copy має один
  idempotent `BOOK_ADDED/CSV` attempt після коміту.

### 8h — onboarding і закриття Етапу 8

- Server-first activation endpoint/checklist, CTA до friends, manual QA scan/CSV.
- Оновити roadmap status, functional specification, user guide/API inventory та
  known limitations за фактичною реалізацією.
- **DoD:** progress 0/1/9/10+, repeat/import refresh і empty/error states tested;
  funnel report відрізняє MANUAL/BARCODE/CSV; усі Stage 8 acceptance criteria green.

## 7. Наскрізна test matrix і release gate

- Shared: valid/invalid boundaries, DTO parity, exact template/header.
- API: positive, negative, permission, idempotency, concurrency, transaction
  rollback, query-count і provider timeout tests.
- Web: route server/client boundary, forms, scanner cleanup, CSV resolution,
  retry/empty/error, accessibility names і focus restoration.
- E2E: manual add → repeat; scan → lookup → Copy; CSV preview → resolve → commit →
  safe rerun; correction creator/owner/stranger; 10th book → friends CTA.
- Build evidence: scan dependency відсутня в initial catalog/new chunk; camera code
  не виконується на server; `docs/specification.md` не змінений.

Stage 8 завершено лише коли всі підетапи merged, root gate green, production-like
migration і manual camera matrix пройдені, а docs описують фактичну поведінку.

## 8. Явне «Не робити»

- Shelf photo, OCR/AI cover recognition, native app, Goodreads sync.
- Title-only CSV, довільне зіставлення колонок, XLSX/Google Sheets integration,
  background jobs або distributed import queue.
- Public catalog edit, admin console, moderation workflow, delete/merge з edit UI.
- Camera frame upload/storage, ISBN lookup на client, довіра до client validation.
- CSV export; коли він з'явиться на Етапі 13, окремо neutralize formula prefixes
  (`=`, `+`, `-`, `@`) за правилами CSV injection defense.
- Invite links і aggregated friend discovery — Етап 9.
- Ratings/reviews — відкладені після Public v1 окремим PO-рішенням.

## 9. Research basis

- MDN: `getUserMedia` потребує secure context і явного дозволу; `facingMode`
  `environment` просить задню камеру.
- MDN: `BarcodeDetector` — experimental/limited availability, тому потрібен
  library fallback, а не залежність від native API.
- `@zxing/browser`: підтримує decode із camera constraints та явний stop control.
- Open Library Books API підтримує кілька `bibkeys` в одному запиті; актуальні
  usage guidelines вимагають кеш, identified `User-Agent` і застерігають від
  сотень single-book requests.
- RFC 4180 задає базову CSV форму; `csv-parse` підтримує BOM, strict column count
  і record-size limits.
- OWASP CSV Injection: імпортований текст не виконується; майбутній export має
  neutralize formula-leading cells.

Посилання:

- <https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia>
- <https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/facingMode>
- <https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector/detect>
- <https://github.com/zxing-js/browser>
- <https://openlibrary.org/dev/docs/api/books>
- <https://openlibrary.org/developers/api>
- <https://datatracker.ietf.org/doc/html/rfc4180>
- <https://csv.js.org/parse/options/>
- <https://wstg.owasp.org/latest/4-Web_Application_Security_Testing/07-Input_Validation_Testing/21-Testing_for_CSV_Injection/>
