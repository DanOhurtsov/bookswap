# Manual QA Етапу 8 — inventory activation

**Призначення:** зафіксувати, що з release gate Етапу 8 (`docs/plan/stage-8-inventory.md`, §7)
перевірено фактично, а що — ні. Документ не є планом тестування: він описує стан
на конкретну дату й у конкретному середовищі.

**Правило заповнення:** `PASS` ставиться лише за фактично виконаною перевіркою.
Якщо сценарій закритий автоматизованим тестом — це позначається як
`PASS (automation)` із посиланням на конкретний файл. Якщо перевірку не виконано —
`NOT RUN`, і вона лишається відкритим пунктом, а не мовчазним припущенням.
Перевірка, виконана руками на фізичному пристрої, позначається `PASS (device)`
із зазначенням пристрою, ОС і браузера.
`PASS (automation)` **не замінює** перевірки, які за визначенням потребують
реального пристрою: жоден jest-тест не доводить, що камера справді вмикається.

---

## Середовища прогонів

Документ склався з двох прогонів у різних середовищах. Обидва зберігаються:
другий не скасовує перший, а закриває частину його `NOT RUN`.

### Прогін 1 — автоматизація й CLI (21 вересня 2026)

| Параметр       | Значення                                                          |
| -------------- | ----------------------------------------------------------------- |
| Дата           | 21 вересня 2026                                                    |
| Гілка          | `codex/8h-onboarding-qa` (на той момент поза `main`; змерджено пізніше, PR #41 / `1958655`) |
| Середовище     | Локальне WSL2 (Linux 6.18), Node 22, PostgreSQL 17 у Docker        |
| Браузер        | **Відсутній.** Прогін виконувався в headless CLI без GUI-браузера  |
| Мобільні пристрої | **Відсутні.** Ні фізичного Android, ні iOS, ні реальної камери  |
| HTTPS          | Немає; локально доступний лише `http://localhost`                  |

Наслідок для цього прогону: **жоден сценарій із реальною камерою в ньому
виконати неможливо.** Це не «ще не встигли» — це відсутність пристрою й
браузера як таких. Усі `PASS (automation)` нижче походять саме звідси.

### Прогін 2 — фізичний iPhone (23 вересня 2026)

| Параметр          | Значення                                                       |
| ----------------- | -------------------------------------------------------------- |
| Дата              | 23 вересня 2026                                                 |
| Гілка / код під тестом | `codex/web-eslint-followup`; scanner UX, збережений у `da1d2fc` |
| Пристрій          | iPhone 17 Pro                                                   |
| ОС                | iOS 27.0                                                        |
| Браузер           | Safari                                                          |
| Доступ            | Єдиний HTTPS-origin через Cloudflare Tunnel (web і API за ним)  |
| Android           | **Відсутній.** Фізичний Android-пристрій у прогін не входив     |

Цей прогін закриває сценарій 3 (iOS Safari). Сценарій 2 (Android Chrome) він
не торкається: HTTPS-адреса тепер є, бракує саме пристрою.

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

### 2. Android Chrome із реальною камерою — `NOT RUN` (release blocker)

| Пункт                       | Стан       |
| --------------------------- | ---------- |
| Запит дозволу               | `NOT RUN`  |
| Скан валідного ISBN         | `NOT RUN`  |
| Lookup за зчитаним ISBN     | `NOT RUN`  |
| Створення `Copy`            | `NOT RUN`  |
| «Сканувати наступну»        | `NOT RUN`  |

**Фактичний результат.** Не виконувалося. Блокує саме відсутність фізичного
Android-пристрою: HTTPS-адреса, якої бракувало 21.09, у прогоні 2 вже була й
відтворюється (див. «Як відтворити стенд для Android QA» нижче). Це єдиний
сценарій, що лишається release blocker Етапу 8.

### 3. iOS Safari із реальною камерою — `PASS` (23.09.2026)

Прогін 2: iPhone 17 Pro, iOS 27.0, Safari, єдиний HTTPS-origin через Cloudflare
Tunnel.

| Пункт                                            | Стан              |
| ------------------------------------------------ | ----------------- |
| Камера не стартує сама, без user gesture         | `PASS (device)`   |
| Запуск після натискання (user gesture)           | `PASS (device)`   |
| Системний запит дозволу                          | `PASS (device)`   |
| Скан друкованого ISBN-13 / EAN-13                | `PASS (device)`   |
| Lookup за відсканованим ISBN                     | `PASS (device)`   |
| Створення `Copy`                                 | `PASS (device)`   |
| «Сканувати наступну»                             | `PASS (device)`   |
| Fallback після Camera Deny                       | `PASS (device)`   |
| Ручне введення ISBN лишається доступним          | `PASS (device)`   |
| Камера звільняється після cancel / navigation    | `PASS (device)`   |
| Вхід у сканування без ручного редагування URL    | `PASS (device)` після `da1d2fc` |

**Фактичний результат.** Сторінка відкривається з кнопкою запуску; камера не
вмикається, доки її не натиснули. Після натискання Safari показує системний
запит дозволу; після «Allow» стартує прев'ю. Друкований EAN-13 зі звороту
паперової книжки декодується, зчитаний ISBN іде в той самий серверний lookup,
що й уведений вручну, і з нього створюється `Copy`. «Сканувати наступну»
повертає до сканера з чистим пошуком і дозволяє додати наступну книжку тим
самим шляхом.

Гілка відмови перевірена окремо: після «Deny» показується україномовне
повідомлення з вказівкою ввести ISBN вручну, і поле ручного введення лишається
доступним і робочим — сценарій додавання не заходить у глухий кут. Після
скасування сканування й після переходу на іншу сторінку індикатор камери iOS
гасне, тобто треки справді зупинено, а не лише приховано прев'ю.

Вхід у сканування відкривається штатною навігацією майстра, без ручного
редагування URL — це поведінка після `da1d2fc`; до нього вхід вимагав правки
адреси вручну.

Адаптивність прев'ю й рамки наведення на екрані iPhone перевірено повторно —
зауважень немає.

**Межі цього PASS.** Перевірено портретну орієнтацію; **окремий landscape-прогін
не фіксувався**, тож PASS на нього не поширюється. Перевірено одну модель
(iPhone 17 Pro, iOS 27.0) в одному браузері (Safari); інші версії iOS,
сторонні браузери на iOS та вбудовані webview не перевірялися.

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

## Повторний автоматизований gate (23 вересня 2026)

Один повний `./gate.sh` на Node 22.23.2 у quiescent-середовищі: dev/watch-процеси,
Caddy і `cloudflared` зупинені перед прогоном (тунель прогону 2 вже був згорнутий).

| Крок                              | Результат                                             |
| --------------------------------- | ----------------------------------------------------- |
| `format:check`                    | ✅                                                    |
| `lint` + `typecheck`              | ✅ (8/8 задач)                                         |
| `test` + `build`                  | ✅ (7/7 задач)                                         |
| `@bookswap/shared` unit           | ✅ 19 наборів / 329 тестів                             |
| `@bookswap/api` unit              | ✅ 58 наборів / 1188 тестів                            |
| `@bookswap/web` unit              | ✅ 48 наборів / 483 тести                              |
| `db:deploy`                       | ✅ dev-база `bookswap`: знайдено 14 міграцій, pending немає |
| `db:seed` двічі                   | ✅ обидва рази успішно                                 |
| `test:db` — e2e                   | ✅ 47 наборів / 632 тести                              |
| `test:db` — db-специфікації       | ✅ 18 наборів / 141 тест                               |
| git hygiene                       | ✅                                                     |
| **Підсумковий exit code**         | **0**                                                  |

Разом 2773 автоматизовані тести. Gate дійшов до фінального `git status` без
жодного failure; exit code 0 підтверджено користувачем.

**Чим цей прогін не є.** Це **не** production-like disposable migration run.
`db:deploy` виконувався проти dev-бази `bookswap` — він лише підтвердив, що всі
14 міграцій на місці й pending немає; порожня одноразова база тут не
створювалася. Тестовий workflow працював зі своєю базою `bookswap_test` і
застосував до неї всі 14 міграцій. Evidence саме production-like міграції
лишається за прогоном 21.09 нижче й цим прогоном не замінюється.

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

1. **Manual camera matrix — `PARTIAL`, release blocker лишається.** Сценарій 3
   (iOS Safari) — `PASS` на фізичному iPhone 17 Pro / iOS 27.0 (прогін 2,
   23.09.2026). Сценарій 2 (Android Chrome) — `NOT RUN`. Release gate §7 плану
   Етапу 8 вимагає всієї матриці, тож **єдиний camera-blocker, що лишився, — це
   фізичний Android Chrome**. Для виконання потрібні: фізичний Android із
   Chrome, книжка з друкованим EAN-13 і стенд за приміткою нижче.
2. **Перевірка сценаріїв 1 і 4–8 у справжньому браузері — не blocker, але борг.**
   Логіка покрита автоматизовано; невиконаною лишається саме візуальна й
   клавіатурна перевірка на реальній сторінці.
3. **Root gate — зелений (exit 0), повторно підтверджено 23.09.2026.** Не
   blocker; див. «Повторний автоматизований gate (23 вересня 2026)» вище.
   Оновлюється лише за фактом нового прогону.
4. **8h у `main` — закрито.** Підетап 8h (8h-1 `8b0432a`, 8h-2 `17d79d0`, 8h-3
   `4c104de`, 8h-4 і 8h-5) змерджено в `main` через PR #41, коміт `1958655`
   (`feat: complete Stage 8 inventory activation`). Гілка
   `codex/8h-onboarding-qa` більше не є станом, що очікує merge.

Змістовний release blocker з цього списку — лише пункт 1, і в ньому лишився
рівно один сценарій: Android Chrome на фізичному пристрої.

## Як відтворити стенд для Android QA

Прогін 2 виконувався через єдиний HTTPS-origin; те саме потрібне Android-у.
Конкретний випадковий hostname тунелю тут свідомо не фіксується — він
одноразовий.

- **Один HTTPS-origin на все.** Web і API мають бути за одним публічним HTTPS
  походженням; `getUserMedia` працює лише в secure context, а мішанина
  origin-ів ламає сесійні cookie.
- **`NEXT_ALLOWED_DEV_ORIGINS`** — hostname **без** схеми (`example.trycloudflare.com`,
  не `https://example.trycloudflare.com`). Значення читає
  `apps/web/next.config.ts` і передає в `allowedDevOrigins`; кілька значень —
  через кому.
- **`WEB_ORIGIN` і `NEXT_PUBLIC_API_URL`** — навпаки, повний HTTPS URL зі
  схемою.
- Далі — сценарій 2 по пунктах: дозвіл → скан друкованого EAN-13 → lookup →
  `Copy` → «Сканувати наступну», плюс гілка Deny і перевірка, що камера
  звільняється після cancel і після навігації.

## Що цей документ не стверджує

- Що сканування перевірено на Android. Сценарій 2 — `NOT RUN`; PASS прогону 2
  стосується лише iOS Safari на iPhone 17 Pro / iOS 27.0.
- Що iOS-сканування перевірено в landscape. Фіксувалася портретна орієнтація;
  окремого landscape-прогону не було.
- Що інтерфейс перевірено клавіатурою й програмою читання з екрана. Це окрема
  перевірка, запланована перед публічним запуском
  (`docs/functional-specification.md`, §11.5).
- Що застосунок готовий до production. Він не готовий; перелік чинних меж —
  `docs/functional-specification.md`, §12.3.
