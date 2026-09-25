# Етап 9 (решта) — network activation і aggregated discovery

**Статус:** РЕАЛІЗОВАНО (функціонально); рішення D1–D6 і scope §3 (варіант A)
затверджено Product Owner 25.09.2026. Baseline `./gate.sh` до змін: exit 0.
Перевірка на реальних мережах — private beta (Етап 11).
**Гілка:** `codex/stage-9-network-activation`.
**Джерело:** [Product Roadmap v2, Етап 9](./roadmap-v2.md#етап-9--network-activation-і-aggregated-discovery).
**Передумови (вже змерджено, не переробляється):** PR #44, #45.

## 1. Product outcome

Нова людина за одну сесію переходить від «мене запросили» до «бачу, що є в друзів
і можу попросити», а наявний користувач не обходить друзів по одному: бачить у
одному списку, хто в його мережі має книгу (або переклад) прямо зараз.

## 2. Метрики

Усі — з `ProductEvent` (Етап 8a), без приватного вмісту. Ціль-числа не
вигадуються: після beta фіксується baseline (roadmap §2).

| Метрика | Визначення | Джерело |
|---|---|---|
| Invite acceptance | `INVITE_ACCEPTED` / `INVITE_SENT` у когорті за період | нові події |
| Usable network | частка користувачів, які мають ≥ 1 прийнятого друга з ≥ 1 видимим `AVAILABLE` примірником вдома (`FRIEND_INVENTORY_USABLE`, один раз на користувача) | нова подія |
| Search → found | користувачі з `FRIEND_BOOK_FOUND` / користувачі з `DISCOVERY_SEARCHED` за добу | нові події |
| Found → request | користувачі з `LOAN_REQUESTED` протягом вікна після `FRIEND_BOOK_FOUND` / користувачі з `FRIEND_BOOK_FOUND` | наявна + нова подія |

Чотири рядки funnel-звіту, які зараз друкують `not instrumented — Stage 9`
(`funnel-report.ts`), отримують реальні значення.

## 3. Розбіжність scope: `/catalog` «Усіх користувачів»

Факти: roadmap виключає «пошук у бібліотеках незнайомців»; `/catalog` після PR #44
має `scope=ALL`, що додає `PUBLIC` примірники незнайомців (`CatalogDiscoveryService`).
Це не витік (публічна полиця + публічний примірник, блок і `PRIVATE`/`FRIENDS`
відсікаються), але формально це саме той пошук, який roadmap виключає.

Варіанти (обрати один; до відповіді режим не змінюється й не розширюється):

- **A (рекомендовано). Залишити як є, але зафіксувати виняток.** Нові можливості
  Етапу 9 (фільтри, Who has this, метрики, browse без тексту) працюють лише в
  `CIRCLE`. У roadmap додається рядок: «перегляд публічних полиць за явним
  перемикачем — успадкований із PR #44, не розвивається». Наслідок: жодних
  destructive-змін; у цьому режимі лишається розрив з формулюванням «Не входить».
- **B. Прибрати перемикач з UI, лишити API.** Найменший ризик суперечності з
  roadmap; наслідок — мертвий код API `scope=ALL` без споживача (порушує
  «без спекулятивних абстракцій»).
- **C. Видалити режим повністю (UI, API, тести, план 9-owned-catalog).** Найчистіше
  відповідає roadmap; це руйнівна зміна вже змерджених, погоджених PR #44/#45.

## 4. Не робити

- Пошук у бібліотеках незнайомців як новий сценарій, marketplace, рекомендації.
- Автоматичну дружбу з токена; прийняття без явної дії запрошеного.
- Сирий токен у БД, логах, analytics, помилках, `Referer`.
- Нову чергу/воркер для листів, retry-схему, Redis, JWT.
- Зміну `Work → Translation → Edition → Copy`, `/loans`, ISBN lookup, майстра.
- Імена позичальників чи текст запиту/нотаток у метриках.
- Wishlist-match, feed, shareable shelf (Етап 12), circles (Етап 14).

## 5. Що вже є (перевірено в коді)

- `GET /catalog/discover` (`CIRCLE`/`ALL`): AVAILABLE + `currentHolderId = ownerId` +
  матриця видимості + блок; власники й `availableCopies`; пагінація. **Немає:**
  фільтрів, browse без `q` (зараз `q` ≥ 2), недоступних/позичених з датою, посилання
  на конкретний `Copy`.
- `expectedReturnOf()` та `canRequestCopy()` (`library.mapper.ts`) — вже реалізують
  privacy-правило дати повернення (лише дата, без позичальника) і серверний
  `canRequest`. **Перевикористовуються, не дублюються.**
- `POST /loans { copyId }` — чинний loan request; `users/[id]/library` вже його викликає.
- `FriendsService.apply()` — єдина точка зміни дружби; `ProductEvent`+`dedupeKey`
  (ідемпотентність за `type+entity+subject`); `EmailSender` (порт); `EMAIL_SENDER`
  використовується лише auth-листами.
- Web: `/works/[id]` без «хто має»; `/register`, `/login` без `returnTo`.

## 6. Рішення Product Owner (потрібне затвердження)

### D1. Строк дії
- **Рекомендація: 14 днів для обох видів, фіксовано**, без вибору користувача.
  Наслідок: простота, передбачуваність; протухле посилання = нове створення.
- Альтернативи: 7 днів (безпечніше, дратує книжкові клуби); 30 днів (довше вікно
  для витоку посилання).

### D2. Revoke
- **Рекомендація:** запрошувач може відкликати будь-яке своє чинне запрошення
  (`DELETE /invitations/:id`), миттєво. Відкликання **не** скасовує вже створену
  дружбу і не чіпає вже накопичені прийняття — лише блокує майбутні.

### D3. Одноразове чи багаторазове
- **Рекомендація:** **email-запрошення — одноразове**; **посилання — багаторазове,
  до 10 прийнятих** (клуб/сім'я), обидва з D1. Повторне відкриття тим самим
  користувачем ідемпотентне (показує поточний стан, не збільшує лічильник); інший
  користувач після вичерпання/expiry/revoke отримує окремий код.
  Наслідок: багаторазове посилання, що потрапило не в ті руки, дає до 10 запитів на
  дружбу — але кожен потребує явної згоди запрошеного, а запрошувач може відкликати.
- Альтернатива: усе одноразове (найбезпечніше, але клуб потребує N посилань).

### D4. Email anti-abuse
- **Рекомендація:** надсилати листи може лише користувач з `emailVerified`; ліміти:
  10 листів на користувача за 24 год; ≤ 3 листи на одного отримувача (за хешем адреси)
  за 7 діб від усіх користувачів; IP-throttle як у auth. Відповідь **однакова**,
  чи має адреса акаунт (без enumeration). Сирий email не зберігається — лише
  HMAC-SHA-256 нормалізованої адреси з ключем `INVITE_EMAIL_HMAC_SECRET`
  (обов'язковий у production, ≥ 32 символи; уточнено після аудиту) для лімітів.
- Ціни: ліміти — константи, змінюються без міграції.

### D5. Доставка листа (потрібно за CLAUDE.md «Escalation»)
Це вибір політики доставки, а не деталь. Варіанти:
- **Рекомендація:** **синхронне надсилання в межах запиту** через `EmailSender`,
  помилка провайдера → `INVITE_EMAIL_FAILED` (502), **запрошення одразу
  відкликається** (`revokedAt`): провайдер міг доставити лист і лише потім
  повернути помилку, а сирий токен не зберігається для повторної відправки.
  **Повторна спроба створює нове запрошення й рахується в ліміти**; повторного
  надсилання того самого запрошення немає. Без черги, ретраїв, drain.
  *(Початкове формулювання «запрошення лишається й його можна відправити знову»
  замінено на це рішення Product Owner 25.09.2026, варіант A.)*
- Фонове завдання в стилі auth (`enqueueEmail`) — вимагає розширення graceful-shutdown
  бюджету `AuthService` або дублювання його, тобто нової підсистеми.
- Черга `NotificationDelivery` — потребує нового «отримувача без User».

### D6. Згода
- **Рекомендація:** прийняття — окрема явна дія («Прийняти дружбу»), що
  створює `ACCEPTED` за один крок, бо запрошувач своєю дією (створенням запрошення)
  вже висловив згоду. Реалізується всередині `FriendsService`
  (нова дія переходу, покрита `friendship.transitions.spec`), а не прямим записом.
  Блок з будь-якого боку → відмова без розкриття причини. Існуюча `PENDING` від
  запрошеного до запрошувача → приймається; `ACCEPTED` → ідемпотентний успіх.

## 7. Підетапи

| # | Зміст | Залежить від |
|---|---|---|
| 9a | Цей план, звірка scope, baseline gate | — |
| 9b | Модель `Invitation`/`InvitationAcceptance`, міграція, API create/list/revoke/resolve/accept, стан-машина | D1–D3, D6 |
| 9c | Email-запрошення: `EmailSender`, ліміти, no-enumeration | D4, D5, 9b |
| 9d | Web: створення/список/revoke, сторінка `/invite`, `returnTo` для login/register, екран згоди | 9b, 9c |
| 9e | Discovery: спільний `NetworkInventory`, фільтри, browse без `q`, недоступні з датою, `copyId`/`canRequest` у видачі, UI «Available from friends» | §3 |
| 9f | «Who has this?»: `GET /works/:id/holders`, Work page, per-Translation, прямий запит | 9e |
| 9g | Події + funnel-звіт | 9b, 9e, 9f |
| 9h | Документація, `./gate.sh` | все |

9e і 9f не залежать від D1–D6, але 9e залежить від §3.

## 8. API (контракти — в `packages/shared`, runtime-валідація DTO)

Усе під `/api/v1`, помилки з машинним `code`.

- `POST /invitations` `{ kind: 'LINK' }` | `{ kind: 'EMAIL', email }` → 201
  `{ invitation, token }` — **єдиний раз**, коли токен повертається; для EMAIL —
  без токена (лист надіслано), `invitation` без email.
- `GET /invitations` — мої (id, kind, status: `ACTIVE|EXPIRED|REVOKED|EXHAUSTED`,
  `expiresAt`, `useCount`, `maxUses`).
- `DELETE /invitations/:id` — revoke (лише запрошувач; чужий id → 404).
- `POST /invitations/resolve` `{ token }` (сесія обов'язкова) → запрошувач
  (`publicUser`), поточне відношення, стан. Токен — у тілі, не в query.
- `POST /invitations/accept` `{ token }` → відношення.
- `GET /catalog/discover` розширюється (`q` необов'язковий, `availability`,
  `language`, `translation`); у `locations[]` з'являються `copies[]`
  (`id`, `editionId`, `translationId`, `status`, `expectedReturnAt`, `canRequest`).
- `GET /works/:id/holders?translationId=&availability=` — згруповано за Translation
  (`null` = оригінал), у кожній групі власники з примірниками.

Коди помилок (нові): `INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_REVOKED`,
`INVITE_EXHAUSTED`, `INVITE_SELF`, `INVITE_EMAIL_FAILED`, `INVITE_RATE_LIMITED`.

## 9. Модель даних і міграція

Одна нова міграція, лише додає таблиці (наявні дані не чіпаються):

- `Invitation(id, inviterId→User cascade, kind, tokenHash unique, recipientEmailHash?,
  maxUses, expiresAt, revokedAt?, createdAt)`; індекси `(inviterId, createdAt)`,
  `(recipientEmailHash, createdAt)`.
- `InvitationAcceptance(id, invitationId→Invitation cascade, userId→User cascade,
  friendshipId?, createdAt)`, `@@unique(invitationId, userId)`.
- `useCount` не зберігається — рахується як `count(InvitationAcceptance)`; ліміт
  тримається умовною вставкою в транзакції, як в інших одноразових токенах.

Міграційний тест: чиста БД → `db:deploy`; повторний `db:deploy` no-op; наявні
таблиці/рядки без змін.

## 10. Правила приватності

- Токен: 256 біт CSPRNG, у БД лише SHA-256, повертається один раз. Посилання —
  `/invite#<token>` (фрагмент не потрапляє до серверних логів/`Referer`); сторінка
  ставить `Referrer-Policy: no-referrer`. Тест: токен не з'являється у логах Nest,
  у відповідях-помилках, у `ProductEvent`.
- Resolve показує запрошувачу лише `publicUser` — і лише залогіненому.
- Discovery/holders: на сервері — сесія, friendship, block, `libraryVisibility ∧
  Copy.visibility`, статус `Copy`, `currentHolderId = ownerId` для «доступних».
  Не-`AVAILABLE`: лише статус і `expectedReturnOf()` (дата, без позичальника);
  `PRIVATE`/`FRIENDS`-чужі примірники не існують у відповіді ні як рядок, ні як лічильник.
- Analytics: лише тип, суб'єкт, псевдонімний ключ; жодних `q`, назв, id книг.

## 11. Тестування

- **Unit:** стан-машина запрошення (expiry/revoke/exhausted/self/повтор), нова дія
  friendship, ліміти, нормалізація/хеш email, приймач фільтрів, `NetworkInventory`.
- **Integration/e2e (реальна БД, підроблений `EmailSender`):** `invite → signup/login →
  accept → visible library`; expiry (керований годинник); revoke; одноразовість і
  конкурентне подвійне прийняття; повторне використання тим самим/іншим користувачем;
  блок (обидва напрямки); no-enumeration email; ліміти; токен не в логах;
  discovery: кожна комбінація visibility × relation × status; позичений не
  «доступний» + дата за правилами; фільтри; holders для Work і Translation;
  запит з результату без повторного пошуку; конкурентні запити на один `Copy`.
- **Analytics:** кожна подія рівно раз (dedupe), payload без приватного вмісту,
  звіт рахує чотири нові переходи.
- **Web:** компонентні тести invite-сторінки (returnTo, згода, помилки), фільтрів,
  Who has this.
- **Migration:** див. §9.

## 12. Definition of done — відповідність тестам

| # | DoD | Чим доведено |
|---|---|---|
| 1 | `invite → signup/login → accept → visible library` | `test/invitations.e2e-spec.ts` «resolve нічого не створює; дружба виникає лише після явного accept» (кінець — `GET /users/:id/library` = 200); `test/invitations-email.e2e-spec.ts` «запрошений за листом реєструється, приймає…»; веб — компонентні тести `InviteAcceptance` (guest → stash + `/login?returnTo=/invite`, явна згода) |
| 2 | Токен: строк, revoke, повторне використання, не в логах | `invitations.e2e-spec.ts`: блоки «строк дії і revoke», «ліміт використань і конкурентність» (12 → 10 дружб; двічі одночасно; revoke ∥ accept), «токен не потрапляє в логи й помилки»; `src/invitations/invitation.rules.spec.ts`; `friendship.transitions.spec.ts` (дія `invite`) |
| 3 | Aggregated search: friendship, block, visibility на сервері | `test/network-discovery.e2e-spec.ts`: «видимість…», «блок у будь-який бік…», «успадкований режим ALL…»; `catalog-discovery.e2e-spec.ts` (регресія PR #44) |
| 4 | Недоступне/позичене не «доступне», дата за privacy-правилами | `network-discovery.e2e-spec.ts` «доступність: … ANY показує позичене з датою й без позичальника», «позичений — не доступний, але з очікуваною датою» |
| 5 | Запит із результату та Work page без повторного пошуку | `network-discovery.e2e-spec.ts` «canRequest збігається з реальною відповіддю POST /loans», «прямий запит із holders без повторного пошуку»; веб — `RequestCopyForm`/`NetworkCopyActions`/`HoldersPanel` тести |
| 6 | Метрики: invite acceptance, usable network, search → found, found → request | `test/analytics-network.e2e-spec.ts` (події, дедуплікація, приватність); `src/analytics/funnel-report.spec.ts` «Stage 9 network steps and metrics»; `test/db/funnel-report-network.db-spec.ts` (реальна БД + `FunnelReportService`) |
| 7 | Чинні маршрути, ISBN lookup, майстер, модель каталогу не зламані | повний `./gate.sh` (exit 0): усі попередні e2e/DB-набори зелені; єдина зміна очікування — `analytics-friends-loans.e2e-spec.ts` (+1 законна подія `FRIEND_INVENTORY_USABLE`) |
| 8 | Міграція безпечна | `test/db/invitations-migration.db-spec.ts` (upgrade populated DB: наявні рядки незмінні; унікальність; cascade) + `prisma migrate diff --exit-code` без розбіжностей зі схемою |
| 9 | `./gate.sh` | exit 0 — див. фінальний звіт |

## 13. Що відрізняється від початкового проєкту плану

- Вибір, який план лишав відкритим: у discovery фільтр «за перекладом» — режим
  `translation=ANY|ORIGINAL|TRANSLATED`; конкретний `translationId` (або
  `original`) приймає лише `GET /works/:id/holders`. Так UI лишається простим без
  окремого довідника перекладів.
- Мова в UI — добірний список (uk, en, pl, de, fr, es, it, cs); API приймає
  будь-який ISO 639-1.
- Збій відправки листа: запрошення одразу отримує `revokedAt`, повторна
  спроба створює нове й рахується в ліміти (затверджено Product Owner, варіант A;
  початковий план обіцяв «лишається чинним»).
- Шість подій замість чотирьох: додано `DISCOVERY_SEARCHED` і
  `WORK_HOLDERS_FOUND`, щоб `search → found` не змішувався з переглядом сторінки
  твору. `INVITE_ACCEPTED` атрибутується **запрошувачу**; ключ дедуплікації
  `DISCOVERY_SEARCHED`/`*_FOUND` — доба.
- Воронка в `funnel:report` переномерована (13 кроків): додано `invite_sent`,
  `invite_accepted`, а `friend_inventory_became_usable` і `friend_book_found`
  отримали реальні значення; кроку «not instrumented» більше немає.
- Нова міграція — лише `20260925090000_stage9_invitations`; SQL записано вручну
  (`prisma migrate dev` вимагав reset dev-БД через давній дрейф чек-сум двох
  міграцій), еквівалентність схемі перевірено `prisma migrate diff --exit-code`.

## 14. Відкриті обмеження

- **Android Chrome QA Етапу 8 — NOT RUN (свідомо відкладено).** Етап 8 і beta
  release gate **не закриті**; Етап 9 їх не закриває й не обходить.
- `friend_inventory_became_usable` перевіряється лише при прийнятті дружби й
  додаванні книжок (включно з CSV); зміна видимості чи повернення примірника нової
  події не дає.
- `found → request` — на рівні користувача (запит після першого «знайдено» у вікні
  конверсії), без атрибуції конкретного запиту до конкретного пошуку.
- Discovery читає доступні примірники в пам'ять перед ранжуванням (ліміт з PR #44);
  за зростання даних потрібен окремий індексований запит.
- Email-запрошення: без черги й ретраїв (D5); `DevEmailSender` друкує тіло листа
  з токеном у лог (dev-only, у проді заборонено).
- **Email-запрошення — одноразове bearer-посилання, не прив'язане до адреси
  акаунта** (рішення Product Owner 25.09.2026). Його може прийняти будь-хто, хто
  має посилання, але лише один раз і з явною згодою; отримувач листа не є
  «єдиною людиною», яка може ним скористатись. Перегляд — на private beta, якщо
  з'явиться зловживання.
- Прострочені та відкликані запрошення не чистяться автоматично (немає фонового
  завдання; вони лишаються як історія).
- Режим `scope=ALL` успадкований від PR #44 і не розвивається.
