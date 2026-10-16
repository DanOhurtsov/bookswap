# BS-92 — уніфіковані селектори: інвентар міграції

Статус: реалізовано на гілці `codex/bs-92-unify-selectors`, очікує рев'ю.

## Рішення

- Короткі фіксовані списки — `SelectField` (`apps/web/components/Form/FormFields.tsx`) на shadcn/ui `Select`
  (`components/ui/select.tsx`, стиль `base-nova`, `@base-ui/react/select`).
- Довгі й динамічні списки — `ComboboxField` (`components/Form/ComboboxField.tsx`) на shadcn/ui `Combobox`
  (`components/ui/combobox.tsx`, `@base-ui/react/combobox`) у варіанті «пошук усередині списку»: закритий
  він виглядає як `Select`, відкритий — має поле пошуку над варіантами.
- Мови — `LanguageSelect` (`components/Form/LanguageSelect.tsx`) поверх `ComboboxField`. Варіанти будуються
  з наявних `LANGUAGE_CODES` (`packages/shared`), `LANGUAGE_HINTS` і `languageName` — окремого словника
  немає. Групи «Поширені» й «Усі мови» збережено. Проп `codes` обмежує набір (фільтр каталогу).
- `components/ui` не містить доменних списків: варіанти, підписи й порожні значення задає виклик.
- Пошук (`components/Form/option-search.ts`): підрядок у видимій назві, без урахування регістру й крайніх
  пробілів; будь-який апостроф (`'`, `’`, `` ` ``) знаходить назву з `ʼ`.
- Пошуковий текст ніколи не є значенням: `onValueChange` отримує лише значення вибраного варіанта.
  Закриття без вибору лишає попереднє значення; наступне відкриття починається з порожнього пошуку.
- Порожнє значення: поле, яке можна очистити, має варіант зі значенням `''` («будь-який», «Не вказано»);
  обов'язкове поле такого варіанта не має, а `''` показується підказкою (placeholder). Перетворення
  `'' ↔ null` лишилося там, де було (у формах), — у запити службові значення UI не потрапляють.
- Вибір завжди за значенням (ID/кодом), а не за назвою: однакові імена друзів, контактів чи перекладів
  розрізняються.
- Вигляд тригера — та сама «рамка поля», що й у текстових полів (`globals.css`): однакова висота,
  відступи, рамка, фокус і стан помилки у світлій і темній темах. `data-ui="button"` вимикає для тригера
  глобальні стилі `button`. Стилі `.field select` і `.search-pagination__size select` перенесено на
  тригери; правила для `option`/`optgroup` у `ManualInlineField` прибрано (списки тепер у порталі з
  кольорами теми).
- React Hook Form: замість `register()` — `Controller`; `field.ref` передається як `inputRef` (приховане
  поле Base UI переводить фокус на тригер), `field.onBlur` — на тригер.
- Inline-редактори (BS-76): `firstControl` фокусує тригер (`role=combobox`), а не приховане поле;
  Enter із поля пошуку (воно в порталі, але React прокидає події крізь портал) не підтверджує поле.
  Escape у відкритому списку закриває лише список — не редактор і не діалог.

## Інвентар

| Екран | Поле | Було | Стало |
| --- | --- | --- | --- |
| `/catalog` | Показувати книжки | нативний `select` у `label` | `SelectField inline` |
| `/catalog` | Доступність | нативний `select` (`FilterSelect`) | `SelectField inline` |
| `/catalog` | Мова | нативний `select`, підписи — коди | `LanguageSelect inline`, `codes=DISCOVERY_LANGUAGES`, «Будь-яка» |
| `/catalog` | Переклад | нативний `select` (`FilterSelect`) | `SelectField inline` |
| `/catalog`, `/catalog/new` | Результатів на сторінці (`SearchPagination`) | нативний `select` у `label` | `SelectField inline` |
| `/catalog/new` (ручна форма) | Мова видання | `LanguageSelect` (нативний) | `LanguageSelect` (combobox) |
| `/catalog/new` (ручна форма) | Мова перекладу | `LanguageSelect` (нативний) | `LanguageSelect` (combobox) |
| `/catalog/new` (ручна форма) | З якої мови перекладено | `LanguageSelect` (нативний) | `LanguageSelect` (combobox) |
| `/catalog/new` (ручна форма) | Палітурка | `SelectField` (нативний) | `SelectField` |
| Виправлення твору | Мова оригіналу | `LanguageSelect` (нативний) | `LanguageSelect` + `Controller` (`ref`, `onBlur`) |
| Виправлення твору | Роль автора | `SelectField` (нативний) | `SelectField` |
| Виправлення перекладу | Мова перекладу, З якої мови перекладено | `LanguageSelect` (нативний) | `LanguageSelect` + `Controller` |
| Виправлення видання | Переклад (прив'язка) | `SelectField` (нативний) | `ComboboxField` (пошук, вибір за ID) |
| Виправлення видання | Що відомо про текст видання | `SelectField` (нативний) | `SelectField` + `Controller` |
| Виправлення видання | Мова видання | `LanguageSelect` (нативний) | `LanguageSelect` + `Controller` |
| Виправлення видання | Палітурка | `SelectField` + `register()` | `SelectField` + `Controller` |
| `/profile` | Видимість бібліотеки за замовчуванням | `SelectField` + `register()` | `SelectField` + `Controller` |
| `/works/[id]` («Це моє видання») | Стан примірника, Кому показувати | `SelectField` (нативний) | `SelectField` |
| `/library` → «Редагувати» | Стан, Кому показувати | `SelectField` (нативний) | `SelectField` |
| `/library` (прихований фільтр) | Доступність | `SelectField` (нативний) | `SelectField` |
| `/library` (прихований фільтр) | Мова | текстове поле `TextField` (код) | `LanguageSelect`, «будь-яка»; `SHOW_STATUS_AND_LANG_FILTERS` лишився `false` |
| `/loans` | Статус | `SelectField` (нативний) | `SelectField` |
| `/library` → «Записати передану книжку» | Кому віддали (друг) | `SelectField` (нативний) | `ComboboxField` (пошук, вибір за ID) |
| `/library` → «Позичити гостю» | Кому віддали (контакт) | `SelectField` (нативний) | `ComboboxField` (пошук, вибір за ID) |

Перевірка повноти: `grep -rn "<select\|<option\|<optgroup" apps/web/app apps/web/components apps/web/features`
(без `*.spec.*`) нічого не знаходить.

## Свідомо не змінено

- Меню аватара, навігація, меню дій рядка (`DropdownMenu`), вкладки, radio («Це переклад?»,
  `ImportRowChooser`), checkbox і пошук наявних авторів у виправленні твору — це не поля вибору значення
  (задача BS-92 їх виключає).
- Код мови в текстових підсумках поза полями вибору (наприклад, «Мова оригіналу uk» на сторінці твору,
  «uk» у картках результатів) — це не dropdown; не змінювалось.

## Перевірки

- Unit/інтеграційні тести: `components/Form/*.spec.*`, `EditionCorrectionForm.spec.tsx`,
  `AddBookScreen.spec.tsx`, `catalog/page.spec.tsx`, `LibraryScreen.shelf.spec.tsx`,
  `RecordExistingLoanForm.spec.tsx`.
- Браузер (Chromium, Playwright): 320/390/768/1024/1280 px, світла й темна теми, сенсорний режим для
  вужчих за 768 px, клавіатура; відповіді API підставлено (див. звіт до задачі).
