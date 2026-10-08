/**
 * Розпізнавання помилок Prisma за кодом.
 *
 * Живе окремо, бо на це спираються три незалежні речі: реєстрація (зайнятий email),
 * створення дружби (гонка двох `INSERT` на ту саму пару) і апрув лоану (гонка на
 * `one_active_loan_per_copy`). Усі мусять читати той самий код; копії розійшлися б
 * при першій же зміні версії Prisma.
 *
 * Перевірка структурна, а не `instanceof`: типи помилок живуть у згенерованому
 * клієнті, і залежність від його внутрішньої структури дорожча за перевірку поля.
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

/** Безпечне читання вкладеного поля без `any` і без припущень про форму. */
function property(source: unknown, key: string): unknown {
  if (typeof source !== 'object' || source === null) return undefined

  return (source as Record<string, unknown>)[key]
}

/**
 * Повідомлення, яке PostgreSQL віддав драйверу.
 *
 * Prisma 7 працює через драйвер-адаптер (`@prisma/adapter-pg`) і кладе оригінальну
 * помилку сюди: `meta.driverAdapterError.cause.originalMessage`. Саме там — і
 * тільки там — є назва **часткового** індексу: у `meta.target` Prisma пише поля
 * ('copyId'), а не ім'я обмеження, бо про сам індекс вона не знає (він дописаний
 * у міграцію руками, поза схемою).
 */
function driverMessage(error: unknown): string | undefined {
  const cause = property(property(property(error, 'meta'), 'driverAdapterError'), 'cause')
  const message = property(cause, 'originalMessage')

  return typeof message === 'string' ? message : undefined
}

/** Назви обмежень, які Prisma віддає безпосередньо, коли знає про них зі схеми. */
function declaredNames(error: unknown): string[] {
  const meta = property(error, 'meta')
  const names: string[] = []

  for (const value of [property(meta, 'target'), property(meta, 'constraint')]) {
    if (typeof value === 'string') names.push(value)
    else if (Array.isArray(value)) names.push(...value.filter((item) => typeof item === 'string'))
  }

  return names
}

/**
 * Порушення **конкретного** унікального обмеження.
 *
 * Навіщо окремо від `isUniqueViolation`: перетворювати будь-який `P2002` на
 * доменний код позичання не можна. Якщо колись зламається зовсім інше обмеження,
 * клієнт отримав би «на примірнику вже є активний лоан» — повідомлення, яке
 * впевнено бреше про причину й веде людину не туди.
 *
 * Ім'я в повідомленні драйвера шукається **в лапках**: без них `includes` дав би
 * хибне спрацювання на обмеженні, назва якого є префіксом іншого.
 *
 * Точна форма `meta` версійно залежна, тож вона не припускається, а **пінується
 * тестом на живій базі** — `test/db/loan-constraints.db-spec.ts` викликає реальне
 * порушення й перевіряє, що ця функція його впізнає, а порушення `User_email_key`
 * — ні. Якщо Prisma колись перенесе назву в інше поле, зламається той тест, а не
 * мовчазне перетворення чужої помилки на доменний код.
 */
export function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  if (!isUniqueViolation(error)) return false

  if (declaredNames(error).includes(constraint)) return true

  return driverMessage(error)?.includes(`"${constraint}"`) ?? false
}

/**
 * PostgreSQL SQLSTATE, коли його бачить драйвер — не Prisma-код.
 *
 * `originalCode`, як і `originalMessage`, живе в `meta.driverAdapterError.cause`
 * (див. коментар над `driverMessage`).
 */
function driverCode(error: unknown): string | undefined {
  const cause = property(property(property(error, 'meta'), 'driverAdapterError'), 'cause')
  const code = property(cause, 'originalCode')

  return typeof code === 'string' ? code : undefined
}

/**
 * Дедлок (40P01) чи serialization failure (40001) — обидва мають однакову
 * відповідь: почати транзакцію заново.
 *
 * Верхній Prisma-код тут **навмисно не перевіряється**: емпірично (пряма
 * провокація дедлоку на живій базі, дві незалежні транзакції, які лочать ті
 * самі два рядки у зворотному порядку) той самий дедлок дає РІЗНИЙ Prisma-код
 * залежно від того, яка саме операція його спіймала — `P2010` для сирого
 * `$queryRaw`, `P2039` для `tx.user.update()`. Єдине стабільне поле в обох
 * випадках — `meta.driverAdapterError.cause.originalCode` = `'40P01'`
 * (SQLSTATE від самого PostgreSQL), тому саме воно тут і читається, а не
 * `error.code`. `test/db/prisma-errors.db-spec.ts` пінує цю форму живим дедлоком
 * так само, як live-DB тести `isUniqueViolationOn` пінують назви обмежень.
 */
export function isDeadlockOrSerializationFailure(error: unknown): boolean {
  const code = driverCode(error)

  if (code === '40P01' || code === '40001') return true

  const message = driverMessage(error)

  return (
    message !== undefined &&
    (message.includes('deadlock detected') || message.includes('could not serialize access'))
  )
}

/**
 * Порушення **конкретного** зовнішнього ключа (SQLSTATE 23503, Prisma `P2003`).
 *
 * Ім'я обмеження шукається в лапках у повідомленні драйвера — так само, як у
 * `isUniqueViolationOn`; форма пінується `test/db/prisma-errors.db-spec.ts` на
 * живому порушенні `Loan_copyId_fkey`.
 */
export function isForeignKeyViolationOn(error: unknown, constraint: string): boolean {
  const isForeignKey =
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003') ||
    driverCode(error) === '23503'

  if (!isForeignKey) return false

  if (declaredNames(error).includes(constraint)) return true

  return driverMessage(error)?.includes(`"${constraint}"`) ?? false
}
