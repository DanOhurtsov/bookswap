# BS-146 — повернення на запитану сторінку після входу

Статус: реалізовано на гілці `codex/bs-146-auth-return-to`, очікує рев'ю.

## Постановка

Гість відкриває захищену сторінку → його перенаправляє на `/login`. Після успішного входу або
реєстрації він має повернутися на ту саму адресу — разом із query-параметрами та hash. Зараз
`returnTo` дозволяє лише точний `/invite`, а guard-и захищених сторінок ведуть на голий `/login`.

API, БД, міграції, `packages/shared` і способи авторизації не змінюються.

## Інвентар

### Способи авторизації (фактично підтримувані)

| Спосіб | Ендпоінт | Екран | Створює сесію |
| --- | --- | --- | --- |
| Вхід email + пароль | `POST /api/v1/auth/login` | `/login` | так |
| Реєстрація email + пароль | `POST /api/v1/auth/register` | `/register` | так |
| Скидання пароля | `POST /api/v1/auth/password-reset/confirm` | `/reset-password` | ні — завершує всі сесії, далі звичайний вхід |
| Підтвердження пошти | `POST /api/v1/auth/email-verification/confirm` | `/verify-email` | ні |

OAuth, magic link тощо відсутні й не додаються.

### Захищені маршрути

Guard на клієнті: поки сесія `loading` — нічого, `guest` — `router.replace` на вхід,
`authenticated` — сторінка, `error` — помилка з «Спробувати ще раз» / «Увійти».

| Маршрут | Де guard |
| --- | --- |
| `/catalog` | `app/(pages)/catalog/page.tsx` |
| `/catalog/new` | `features/catalog/add-book/components/AddBookScreen.tsx` |
| `/contacts` | `app/(pages)/contacts/page.tsx` |
| `/copies/[id]/history` | `app/(pages)/copies/[id]/history/page.tsx` |
| `/friends` | `components/Friends/FriendsSessionBoundary.tsx` |
| `/friends/search` | `features/user-search/components/UserSearchScreen.tsx` |
| `/library` | `features/library/own-library/components/LibraryScreen.tsx` |
| `/library/[entryId]` | `features/library/own-book/components/OwnBookScreen.tsx` |
| `/loans` | `features/loans/components/LoansScreen.tsx` |
| `/loans/guest` | `app/(pages)/loans/guest/page.tsx` |
| `/notifications` | `app/(pages)/notifications/page.tsx` |
| `/notifications/settings` | `app/(pages)/notifications/settings/page.tsx` |
| `/profile` | `features/profile/components/ProfileScreen.tsx` |
| `/users/[id]/library` | `app/(pages)/users/[id]/library/page.tsx` |
| `/wishlist` | `app/(pages)/wishlist/page.tsx` |
| `/works/[id]` | `app/(pages)/works/[id]/page.tsx` |
| `/invite` | `features/network/components/InviteAcceptance.tsx` — власний сценарій, див. R2 |

Серверні перенаправлення на захищені маршрути: `/history` → `/loans?tab=history`,
`/reading-list` → `/library`. Гість проходить їх до guard-а, тож `returnTo` — уже кінцева адреса.

Без guard-а сесії, лише 401 від API: `/library/imports`, `/library/imports/[id]` — показують
`ImportFailureNotice` із посиланням «Увійти».

Публічні: `/`, `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`,
`/guest-loan-confirmation`.

## Рішення

**R1. Перевірка адреси — одна функція `safeReturnTo` (`app/lib/return-to.ts`).** Дозволено лише
канонічний внутрішній шлях:

- починається з одного `/` (не `//`), без `\` і керівних символів (U+0000–U+001F, U+007F);
- `new URL(value, <службове походження>)` не змінює походження і серіалізується в той самий рядок —
  тобто нічого з того, що парсер переписав би (dot-сегменти, вирізані tab/newline, підмішані схема
  чи хост), не проходить;
- не сторінка входу: `/login`, `/register` (зокрема з кінцевим `/`) — інакше цикл авторизації;
- `/invite` — лише точно `/invite` (R2).

Список дозволених маршрутів не ведеться: він дублював би дерево `app/` і розходився б із ним.
Неіснуюча чи недоступна адреса після входу показує свій штатний стан (404 Next, «Сторінку не
знайдено», помилку ресурсу). Некоректне чи відсутнє значення → стандартний маршрут `/`.

**R2. `/invite` без змін.** Токен запрошення живе у hash і ніколи не потрапляє в URL-запит:
`InviteAcceptance` кладе його в `sessionStorage` і веде на `/login?returnTo=/invite`. Тому
`/invite?…` і `/invite#…` як `returnTo` відхиляються, а спільний guard на `/invite` не
використовується.

**R3. Адресу повернення бере guard у браузері.** `pathname + search + hash` читаються з
`window.location` у момент перенаправлення (в ефекті): hash є лише в браузері, сервер його не бачить.
Один хук `useGuestRedirect(status)` (`app/lib/use-login-redirect.tsx`) замінює однакові ефекти всіх
guard-ів — правило «гостя ведемо на вхід із поверненням» живе в одному місці.

**R4. Посилання «Увійти» в станах захищених сторінок теж несуть `returnTo`**: помилка перевірки сесії
(`/works/[id]`, `/copies/[id]/history`, `/users/[id]/library`, `/library/[entryId]`), «Переадресовую до
входу» на `/friends`, 401 CSV-імпорту. Компонент `LoginLink` читає адресу через
`useSyncExternalStore` (на сервері й під час гідратації — `/login`).

**R5. Навігацію після входу робить лише один ефект.** До BS-146 `submit` викликав `router.push(target)`,
а ефект «уже авторизований» одразу після `setUser` — `router.replace(target)`: дві конкурентні навігації.
Виміряно в реальному браузері (Next 16.3.1): цільова сторінка запитувалася двічі (два RSC-запити), а
результат в історії залежав від того, яку навігацію Next обробить останньою (у вимірі пізніший `replace`
перекривав `push`). Після BS-146 `submit` лише оновлює сесію, а ефект за `authenticated` робить
`router.replace(safeReturnTo(returnTo))` — той самий шлях і для щойно увійденого, і для вже
авторизованого: один запит, і «Назад» не повертає на форму входу. Альтернатива — лишити `push` у
`submit` і вимикати ефект на час submit (прапорець): більше стану, і `/login` лишився б в історії.

**R6. `returnTo` між login і register** — наявний `returnToQuery` у перехресних посиланнях; помилка
форми не змінює адресу, тож повторна спроба має той самий `returnTo`.

## Межі

- Посилання «Увійти» в шапці (`constants/navigation.tsx`) не змінюється: воно на публічних сторінках.
- Скидання пароля не переносить `returnTo`: посилання приходить листом, і після скидання людина
  входить заново.
- `/library/imports*` не отримують guard сесії (це змінило б, які запити й коли надсилаються) — лише
  `returnTo` у посиланні «Увійти».
- `returnTo` — параметр запиту `/login`, тож потрапляє в журнали web-сервера; серед захищених сторінок
  секрет у hash має лише `/invite`, і він виключений (R2).

## Критерії готовності та перевірки

| Вимога | Доказ |
| --- | --- |
| Перевірка адреси, fallback, open-redirect обходи, цикл, `/invite` | `app/lib/return-to.spec.ts` |
| Guard зберігає pathname + search + hash, нічого не робить для `loading`/`authenticated`/`error` | `app/lib/use-login-redirect.spec.tsx` |
| Усі захищені маршрути використовують спільний guard | `app/lib/guest-redirect-routes.spec.ts` + наявні специфікації екранів |
| Login/register: повернення, fallback, помилка → повтор, перехресні посилання, одна навігація | `app/(pages)/login/page.spec.tsx`, `app/(pages)/register/page.spec.tsx`, `app/lib/session-lifecycle.spec.tsx` |
| `/invite` без змін | `InviteAcceptance.spec.tsx` (без змін очікувань) |
| Реальний браузер | `apps/api/test/browser/auth-return-to.browser-spec.ts` |

Браузерний сценарій (реальні `next dev`, API в процесі тесту й тестова БД, Chromium; синтетичні акаунти;
нічого не підставлено — ні API, ні роутер, ні дані):

1. Гість → `/loans?tab=history&bs146=1#history` → `/login?returnTo=…` (адреса повністю, з hash) → невірний
   пароль (помилка, адреса й посилання «Зареєструватися» з тим самим `returnTo`) → вірний → та сама адреса,
   вкладка «Історія» вибрана; один запит цільової сторінки після submit; довжина історії вкладки не росте.
2. Гість → `/works/<id>?from=bs146#editions` → login → «Зареєструватися» → зайнятий email (помилка, адреса
   й «Увійти» з тим самим `returnTo`) → новий email → твір за початковою адресою.
3. Авторизований → `/wishlist?bs146=1#top`: жодної навігації через `/login`; авторизований →
   `/login?returnTo=%2Fprofile%23email` → одразу профіль, без форми.
4. Після входу: неіснуючий твір — «Твір не знайдено», неіснуючий примірник — «Книжку не знайдено»,
   неіснуючий маршрут — штатна 404 Next; адреса лишається запитаною.
5. `returnTo` = зовнішня адреса, `//…`, `/\…`, `javascript:`, `/login?returnTo=…` → після входу `/`, жодної
   навігації за межі web-походження.

Мутаційна перевірка: із поверненим `router.push` у `submit` сценарій 1 падає (2 запити цільової сторінки
замість 1).

Середовище браузера:

- У WSL бракує `libasound.so.2` — взято з пакета `libasound2t64` (`apt-get download`, розпаковано в
  тимчасову теку, `LD_LIBRARY_PATH`), як у BS-133/BS-143.
- Dev-сервер користувача на 3000 тримає lock `apps/web/.next/dev`, а другий `next dev` з тієї ж теки
  не стартує («Another next dev server is already running»). Зупиняти сервер не можна, тож браузерний
  тест запускався з копії робочого дерева в тимчасовій теці (без `.git`/`node_modules`/`.next`,
  `pnpm install --prefer-offline --frozen-lockfile`); після прогонів копія звірена з репозиторієм
  (`diff -r`, відрізняється лише згенерований `next-env.d.ts`).

## Перевірка

- Baseline до змін: увесь web — 1967 з 1970; 3 падіння — таймаути 5 с у `contacts/page.spec.tsx` і
  `AddBookScreen.spec.tsx` під load average ~50; окремо обидва файли зелені (160 з 160).
- Web після змін: специфікації guard-ів, форм, `app/lib`, `features/library|loans|user-search|profile|network`,
  `components/Friends|NavBar` — 1022 з 1022; нові `return-to.spec.ts` (54), `use-login-redirect.spec.tsx` (9),
  `guest-redirect-routes.spec.ts` (324), `login/page.spec.tsx`; `InviteAcceptance.spec.tsx` і
  `session-lifecycle.spec.tsx` — без змін очікувань.
- Змінені очікування наявних тестів (свідома зміна поведінки BS-146): guard-и `/contacts`, `/friends`,
  `/catalog/new`, `/library`, `/library/[entryId]`, `/friends/search`, `/profile`, посилання 401 CSV-імпорту —
  `/login` → `/login?returnTo=…`; `register/page.spec.tsx` — `push('/')` → одна `replace('/')`;
  `return-to.spec.ts` — `/profile?x=1` і `/library` тепер дозволені.
- Браузер: `auth-return-to` — 12 з 12, три запуски поспіль.
- `pnpm lint`, `pnpm typecheck`, `pnpm format:check` — чисто.
- `./gate.sh` — не завершився: Claude Code зупинив його через нестачу пам'яті в системі на кроці тестів web.
  До зупинки: format, lint і typecheck (8 з 8), shared 671, api 2130 — зелені; web — 4 файли з таймаутом
  5 с (файли йшли по 190–200 с) і один каскадний збій після таймауту в тому самому файлі; окремо ці 4 файли
  зелені (29 з 29). `build` і `test:db` не запускались. Залишок фікстури `import-rules.spec.ts`
  (`features/other-feature/`), який не встиг прибрати вбитий прогін, видалено.
