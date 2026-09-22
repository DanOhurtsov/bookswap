# Manual QA Етапу 8 — inventory activation

**Призначення:** зафіксувати, що з release gate Етапу 8 (`docs/plan/stage-8-inventory.md`, §7)
перевірено фактично, а що — ні. Документ не є планом тестування: він описує стан
на конкретну дату й у конкретному середовищі.

**Правило заповнення:** `PASS` ставиться лише за фактично виконаною перевіркою.
Якщо сценарій закритий автоматизованим тестом — це позначається як
`PASS (automation)` із посиланням на конкретний файл. Якщо перевірку не виконано —
`NOT RUN`, і вона лишається відкритим пунктом, а не мовчазним припущенням.
`PASS (automation)` **не замінює** перевірки, які за визначенням потребують
реального пристрою: жоден jest-тест не доводить, що камера справді вмикається.

---

## Середовище прогону

| Параметр       | Значення                                                          |
| -------------- | ----------------------------------------------------------------- |
| Дата           | 21 вересня 2026                                                    |
| Гілка          | `codex/8h-onboarding-qa` (8h-1 — 8h-4, ще не в `main`)             |
| Середовище     | Локальне WSL2 (Linux 6.18), Node 22, PostgreSQL 17 у Docker        |
| Браузер        | **Відсутній.** Прогін виконувався в headless CLI без GUI-браузера  |
| Мобільні пристрої | **Відсутні.** Ні фізичного Android, ні iOS, ні реальної камери  |
| HTTPS          | Немає; локально доступний лише `http://localhost`                  |

Наслідок, який визначає весь документ нижче: **жоден сценарій із реальною камерою
в цьому середовищі виконати неможливо.** Це не «ще не встигли» — це відсутність
пристрою й браузера як таких.

---

## Матриця сценаріїв

### 1. Desktop без камери або із забороненим дозволом

| Пункт                                          | Стан               |
| ---------------------------------------------- | ------------------ |
| Сканер не стартує самостійно                   | `PASS (automation)` |
| Повідомлення про помилку зрозуміле             | `PASS (automation)` |
| Ручне введення ISBN лишається доступним        | `PASS (automation)` |
| Після закриття ресурси камери звільнено        | `PASS (automation)` |
| Те саме у справжньому desktop-браузері         | `NOT RUN`          |

**Фактичний результат.** Компонент рендериться з кнопкою «Увімкнути камеру» й не
звертається ні до `getUserMedia`, ні до модуля сканера, доки на неї не натиснули;
модуль вантажиться dynamic import лише після кліку. Для кожної причини відмови
(`permission-denied`, `no-camera`, `camera-busy`, `unsupported`, `timeout`,
`unknown`) є окреме україномовне повідомлення, і кожне з них закінчується
вказівкою ввести ISBN вручну. Поле ручного введення рендериться незалежно від
стану сканера. Зупинка перевірена з чотирьох боків: cancel, unmount, повторний
`stop()` та декодування, що завершилося вже після `stop()` — в останньому випадку
контролери сесії все одно зупиняються, і всі `MediaStreamTrack` на `<video>`
теж.

**Automation:**

- `apps/web/features/catalog/add-book/components/BarcodeScannerPanel.spec.tsx`
  — «renders a start button and requests nothing on mount», «loads the scanner
  module only after clicking start», «shows the unsupported-browser message and
  never attempts to load the scanner when unsupported», «a camera error shows its
  message and a retry that re-arms the start button», «cancel stops the scanner
  and returns to the start state», «unmounting while scanning stops the
  underlying scanner»;
- `apps/web/features/catalog/add-book/lib/barcode-scanner.client.spec.ts`
  — «stops all MediaStreamTrack instances on the video element when stopping»,
  «a decode session that resolves after stop() still gets its own controls
  stopped (no leaked camera)», «stop() is idempotent», «is false when the context
  is not secure».

**Чому лишається `NOT RUN` частина.** Тести працюють проти підробленого
`navigator.mediaDevices`. Вони доводять логіку компонента, але не доводять, що
конкретний desktop-браузер віддає саме ті помилки, які ця логіка розрізняє.

### 2. Android Chrome із реальною камерою

| Пункт                       | Стан       |
| --------------------------- | ---------- |
| Запит дозволу               | `NOT RUN`  |
| Скан валідного ISBN         | `NOT RUN`  |
| Lookup за зчитаним ISBN     | `NOT RUN`  |
| Створення `Copy`            | `NOT RUN`  |
| «Сканувати наступну»        | `NOT RUN`  |

**Фактичний результат.** Не виконувалося. У середовищі немає ні Android-пристрою,
ні HTTPS-адреси, з якої мобільний браузер міг би відкрити застосунок. Перевірка
неможлива без окремого стенду.

### 3. iOS Safari із реальною камерою

| Пункт                                  | Стан       |
| -------------------------------------- | ---------- |
| Запит дозволу                          | `NOT RUN`  |
| Скан валідного ISBN                    | `NOT RUN`  |
| Lookup, створення `Copy`, «наступна»   | `NOT RUN`  |
| Fallback, якщо сканування недоступне   | `NOT RUN`  |

**Фактичний результат.** Не виконувалося, з тієї самої причини. Для iOS ризик
вищий, ніж для Android: Safari історично обмежує `getUserMedia` у вбудованих
webview й потребує саме secure context, тож поведінку fallback треба побачити на
пристрої, а не вивести з коду.

### 4. Ручне додавання → повтор того самого `Edition`

| Пункт                                      | Стан                |
| ------------------------------------------ | ------------------- |
| Створюються окремі `Copy`                  | `PASS (automation)` |
| `condition` / `visibility` збережені       | `PASS (automation)` |
| `note` / `acquiredAt` очищені              | `PASS (automation)` |
| Прогрес активації оновлюється              | `PASS (automation)` |
| Те саме у справжньому браузері             | `NOT RUN`           |

**Фактичний результат.** Після успішного додавання майстер показує три дії, і
«Ще один такий примірник» повертає до кроку `Copy` з тим самим `editionId`,
надсилаючи другий `POST /me/library` — окремий рядок `Copy`, без поля кількості.
У тілі другого запиту `condition` і `visibility` дорівнюють обраним на першій
книжці, а `note` й `acquiredAt` — `null`. Нічого не пишеться у `localStorage`.
Кожен успішний `POST` інвалідує саме запит `['activation']`; відхилений — не
інвалідує нічого.

**Automation:**

- `apps/web/features/catalog/add-book/components/AddBookWizard.spec.tsx`
  — «adds another Copy for the same Edition and keeps only safe session
  defaults», «opens the scanner entry URL and starts with a clean search»;
- `apps/web/features/catalog/add-book/components/CopyStep.activation.spec.tsx`
  — «успішний POST /me/library інвалідує саме ["activation"]», «repeat add — той
  самий крок удруге — інвалідує ще раз», «відхилений POST не інвалідує нічого»;
- `apps/api/test/activation.e2e-spec.ts`
  — «перша книжка, додана справжнім POST /me/library, потрапляє в прогрес».

### 5. Дев'ята → десята книжка

| Пункт                              | Стан                |
| ---------------------------------- | ------------------- |
| Прогрес 9 → 10                     | `PASS (automation)` |
| CTA змінюється на `/friends`       | `PASS (automation)` |
| Те саме у справжньому браузері     | `NOT RUN`           |

**Фактичний результат.** На дев'ятій книжці `hasReachedTarget` лишається `false`,
а `nextAction` — `ADD_BOOKS`; перехід відбувається рівно на десятій, у тому самому
запиті, що її створив. Понад десять — лічильник росте, дія лишається
`INVITE_FRIENDS`. У UI до десятої книжки кнопка веде на `/catalog/new`, від
десятої — на `/friends`. Видалення примірника зменшує число: перевірено окремо,
бо це головна причина не рахувати активацію за подіями аналітики.

**Automation:**

- `apps/api/test/activation.e2e-spec.ts` — «дев'ята книжка ще не відкриває
  запрошення друзів», «десята книжка перемикає наступну дію на друзів», «дев'ята
  книжка стає десятою рівно тоді, коли її додали», «понад десять — лічильник
  росте далі», «видалений примірник зменшує прогрес», «власна книжка рахується
  попри status, visibility і чужого тримача», «чужі примірники не рахуються»;
- `apps/web/features/library/activation/components/ActivationChecklist.spec.tsx`
  — «девʼята книжка ще не відкриває друзів», «десята книжка веде до друзів»,
  «нуль книжок: кличе додати першу».

### 6. CSV: шаблон → preview → resolve/skip → commit

| Пункт                              | Стан                |
| ---------------------------------- | ------------------- |
| Шаблон                             | `PASS (automation)` |
| Preview без доменних записів       | `PASS (automation)` |
| Resolve / skip рядка               | `PASS (automation)` |
| Commit                             | `PASS (automation)` |
| Повторний commit без дублювання    | `PASS (automation)` |
| Прогрес активації оновлений        | `PASS (automation)` |
| Те саме у справжньому браузері     | `NOT RUN`           |

**Фактичний результат.** Контрактний тест читає реальний asset
`apps/web/public/library-import-template.csv` тим самим парсером, що й завантажений
файл, і звіряє заголовок зі спільною константою — розбіжність шаблона й коду
неможлива непомітно. Preview створює чернетку й не пише ні `Work`, ні
`Translation`, ні `Edition`, ні `Copy`. Commit створює весь ланцюг за одну
транзакцію; пропущені рядки не імпортуються; нерозв'язані — блокують коміт і
названі поіменно. Повторний коміт повертає збережений результат — і зі старим
токеном чернетки, і після TTL. На кожен створений `Copy` припадає рівно одна
подія `BOOK_ADDED` з `method: CSV`, а збій аналітики не перетворює успішний
імпорт на помилку. Після коміту UI показує той самий чекліст активації, що й
бібліотека.

**Automation:**

- `apps/api/src/library/import/library-import-template.spec.ts` — шаблон проти
  спільної константи;
- `apps/api/test/library-import-preview.e2e-spec.ts`,
  `apps/api/test/library-import-rows.e2e-spec.ts`,
  `apps/api/test/library-import-staleness.e2e-spec.ts`,
  `apps/api/test/library-import-rate-limit.e2e-spec.ts`,
  `apps/api/test/library-import-scale.e2e-spec.ts`;
- `apps/api/test/library-import-commit.e2e-spec.ts` — «створює весь ланцюг
  каталогу й примірники за один коміт», «пропущені рядки не імпортуються»,
  «повторний коміт повертає збережений результат», «нерозвʼязані рядки блокують
  коміт і названі поіменно», «на кожен створений Copy припадає рівно одна подія
  BOOK_ADDED/CSV», «збій analytics не робить успішний імпорт помилкою»;
- `apps/api/test/library-import-commit-concurrency.e2e-spec.ts` — конкурентний і
  подвійний коміт;
- `apps/web/features/library/csv-import/components/CsvImportUpload.spec.tsx`,
  `CsvImportDraft.spec.tsx`,
  `apps/web/features/library/csv-import/model/library-after-commit.spec.tsx`.

### 7. XLSX

| Пункт                                        | Стан                |
| -------------------------------------------- | ------------------- |
| Еквівалентний preview і readiness            | `PASS (automation)` |
| Commit                                       | `PASS (automation)` |
| Пошкоджена книга — контрольована помилка     | `PASS (automation)` |
| Те саме у справжньому браузері                | `NOT RUN`           |

**Фактичний результат.** Робоча книга дає ті самі рядки, лічильники й readiness,
що й еквівалентний CSV, і так само нічого не пише в каталог чи бібліотеку.
Повторне завантаження тієї самої книги відповідає тією самою чернеткою.
Відмови контрольовані й названі: формула в клітинці (із вказанням клітинки),
кілька аркушів із даними замість одного, `.xls` або файл під паролем (одна чесна
спільна причина — обидва є контейнерами CFB і надійно не розрізняються),
CSV, надісланий як книга, перевищення байтового ліміту з фактичним розміром.
Жодна відмова не повертає вмісту файла.

**Automation:**

- `apps/api/test/library-import-xlsx.e2e-spec.ts` — «produces the same rows,
  counts and readiness as the equivalent CSV», «writes nothing to the catalog or
  the library», «answers a repeated upload of the same workbook with the same
  draft», «refuses a formula and names the cell», «asks for one data sheet
  instead of picking one», «refuses a legacy .xls or password-protected file with
  one honest reason», «refuses a workbook past the byte cap with its real size»,
  «never echoes file content in a refusal»;
- `apps/api/src/library/import/library-import-xlsx.reader.spec.ts`,
  `library-import-zip.spec.ts`, `library-import-ooxml.spec.ts`.

### 8. Виправлення метаданих

| Пункт                                   | Стан                |
| --------------------------------------- | ------------------- |
| Права creator / owner / stranger        | `PASS (automation)` |
| Аудит змін                              | `PASS (automation)` |
| Обробка конфліктів                      | `PASS (automation)` |
| Те саме у справжньому браузері          | `NOT RUN`           |

**Фактичний результат.** Creator редагує; власник `Copy` відповідного видання
редагує, навіть не будучи creator; сторонній отримує `403
CATALOG_EDIT_FORBIDDEN`, і дані не змінюються. Успішний `PATCH` збільшує
`revision` і записує `CatalogRevision` із повним знімком «до» і «після» у тій
самій транзакції; помилка всередині (наприклад, неіснуючий `authorId`) відкочує
і поле, і `revision`, і аудит. Два конкурентні `PATCH` з однаковим
`expectedRevision` дають рівно один `200` і один `409
CATALOG_REVISION_CONFLICT`. Перевірені й межі: зайнятий ISBN, чужий переклад,
`PATCH` по вже об'єднаному `Work`, а також гонка `PATCH` проти merge в обох
порядках.

**Automation:**

- `apps/api/test/catalog-correction.e2e-spec.ts` — блоки «R8:
  creator/owner/stranger», «R9: revision + audit», «Чинні правила каталогу
  зберігаються», «R10a: заміна й порядок авторів», «Конкурентність PATCH проти
  MergeService», «доступ без сесії»;
- `apps/api/test/db/catalog-revision.db-spec.ts`,
  `catalog-correction-schema.db-spec.ts`,
  `catalog-correction-rollback.db-spec.ts`,
  `catalog-correction-recovery.db-spec.ts`,
  `catalog-correction-backfill.db-spec.ts`;
- `apps/web/features/catalog/correction/model/use-catalog-correction.spec.tsx`.

---

## Результат автоматизованого gate (21 вересня 2026)

Один повний `./gate.sh` у quiescent-середовищі (dev/watch-процеси зупинені
перед прогоном), проти окремої disposable-бази; dev-база не чіпалася.

| Крок                              | Результат                                             |
| --------------------------------- | ----------------------------------------------------- |
| `format:check`                    | ✅                                                    |
| `lint` + `typecheck`              | ✅ (8 задач)                                           |
| `test` + `build`                  | ✅ (7 задач)                                           |
| `@bookswap/shared` unit           | ✅ 19 наборів / 329 тестів                             |
| `@bookswap/api` unit              | ✅ 58 наборів / 1188 тестів                            |
| `@bookswap/web` unit              | ✅ 47 наборів / 467 тестів                             |
| `db:deploy` на порожню базу       | ✅ 14/14 міграцій                                      |
| `db:seed` двічі                   | ✅ ідемпотентно                                        |
| `test:db` — e2e                   | ✅ 47 наборів / 632 тести                              |
| `test:db` — db-специфікації       | ✅ 18 наборів / 141 тест                               |
| **Підсумковий exit code**         | **0**                                                  |

Разом 2757 автоматизованих тестів.

**Попередній прогін (раніше того самого дня) був червоним:**
`test/db/catalog-correction-rollback.db-spec.ts` дав
`Exceeded timeout of 5000 ms for a hook` у `afterAll` → `scratch.cleanup()`.
`DROP DATABASE` зрештою виконався (осиротілих `*_migration_scratch_*` баз не
лишилося), ізольований повторний прогін — PASS. **Точний чинник того
одиничного уповільнення не встановлено**; db-набір виконується в один потік
(`maxWorkers: 1`), тож паралельне навантаження ним не є.

Після нього внесено test-only hardening — явний 15-секундний бюджет саме для
scratch cleanup hooks; глобальний `testTimeout` і `maxWorkers` не змінювалися.
Аналіз: `docs/plan/stage-8-inventory.md`, «Падіння db-набору 21.09.2026 і
test-only hardening».

## Відкриті пункти перед закриттям Етапу 8

1. **Manual camera matrix на реальних пристроях — release blocker.** Сценарії 2 і
   3 повністю `NOT RUN`. Release gate §7 плану Етапу 8 прямо вимагає їх
   проходження. Для виконання потрібні: HTTPS-адреса застосунку (реальний
   сертифікат або тунель), фізичний Android із Chrome і фізичний iPhone із
   Safari, а також книжка з друкованим EAN-13.
2. **Перевірка сценаріїв 1 і 4–8 у справжньому браузері — не blocker, але борг.**
   Логіка покрита автоматизовано; невиконаною лишається саме візуальна й
   клавіатурна перевірка на реальній сторінці.
3. **Root gate — зелений (exit 0).** Не blocker; див. «Результат
   автоматизованого gate» вище. Оновлюється лише за фактом нового прогону.
4. **8h не в main — не blocker, а стан гілки.** Увесь підетап живе на
   `codex/8h-onboarding-qa` й очікує commit/PR/merge: 8h-1 (`8b0432a`), 8h-2
   (`17d79d0`), 8h-3 (`4c104de`), а також 8h-4 і 8h-5, реалізовані в тій самій
   гілці.

Змістовний release blocker з цього списку — лише пункт 1.

## Що цей документ не стверджує

- Що сканування працює на реальному пристрої. Цього ніхто не перевіряв.
- Що інтерфейс перевірено клавіатурою й програмою читання з екрана. Це окрема
  перевірка, запланована перед публічним запуском
  (`docs/functional-specification.md`, §11.5).
- Що застосунок готовий до production. Він не готовий; перелік чинних меж —
  `docs/functional-specification.md`, §12.3.
