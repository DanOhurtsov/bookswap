import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isValidIsbn13, isbn13Schema } from '@bookswap/shared'
import { uniqueIsbn13 } from './helpers/unique-isbn'

/**
 * Аудит cleanup Stage 7: ізольований прогін лише `catalog-lookup.e2e-spec.ts`
 * і `catalog-lookup-rate-limit.e2e-spec.ts` разом падав 5 тестами — оба файли
 * рахували ISBN-тіло як `(pid % 100_000) * 100 + локальний sequence`, а
 * `sequence` у кожному файлі стартував з нуля. Jest ізолює модулі на кожен
 * spec-файл (свіжий registry на файл), тож спільним лишався тільки
 * `process.pid` — однаковий для всіх файлів одного worker'а. Перший виклик
 * `isbn()` у двох файлах давав ІДЕНТИЧНИЙ номер: перший файл кешував
 * відповідь під цим ISBN у `ExternalBookLookup`, другий отримував cache hit
 * замість виклику власного fake-провайдера.
 *
 * Нижче: (1) старий алгоритм гарантовано відтворює колізію — локальна копія
 * старої формули, а не вигадана; (2) новий `uniqueIsbn13`
 * (`./helpers/unique-isbn.ts`) тієї самої колізії не дає для тих самих двох
 * «файлів».
 */
describe('колізія старого генератора ISBN (regression proof)', () => {
  /** Точна копія старої формули з кожного catalog-lookup*.e2e-spec.ts. */
  function legacyIsbnGenerator(pid: number) {
    let sequence = 0

    return (): string => {
      sequence += 1

      const body = `978${String((pid % 100_000) * 100 + sequence).padStart(9, '0')}`
      let sum = 0

      for (const [index, character] of [...body].entries()) {
        sum += Number(character) * (index % 2 === 0 ? 1 : 3)
      }

      return `${body}${String((10 - (sum % 10)) % 10)}`
    }
  }

  it('старий генератор: два файли (спільний pid, свій sequence з нуля) дають ІДЕНТИЧНИЙ перший ISBN', () => {
    const sharedPid = process.pid

    // Кожен spec-файл у Jest — окремий module registry, тож `let sequence = 0`
    // на верхньому рівні файлу справді стартує з нуля незалежно в кожному.
    const fileA = legacyIsbnGenerator(sharedPid)
    const fileB = legacyIsbnGenerator(sharedPid)

    expect(fileA()).toBe(fileB())
  })

  it('новий uniqueIsbn13: ті самі два "файли" (різні namespace) не колізять на першому виклику', () => {
    const first = uniqueIsbn13('regression-proof-file-a')
    const second = uniqueIsbn13('regression-proof-file-b')

    expect(first).not.toBe(second)
  })
})

describe('uniqueIsbn13', () => {
  it('повертає ISBN-13, валідний за фактичною доменною перевіркою', () => {
    const value = uniqueIsbn13('validity-check')

    expect(isValidIsbn13(value)).toBe(true)
    expect(isbn13Schema.safeParse(value).success).toBe(true)
  })

  it('послідовні виклики в одному namespace унікальні', () => {
    const values = Array.from({ length: 50 }, () => uniqueIsbn13('sequential-namespace'))

    expect(new Set(values).size).toBe(50)
  })

  it('ці два namespace не перетинаються після багатьох викликів кожного', () => {
    const a = Array.from({ length: 20 }, () => uniqueIsbn13('namespace-a'))
    const b = Array.from({ length: 20 }, () => uniqueIsbn13('namespace-b'))

    expect(new Set([...a, ...b]).size).toBe(40)
  })

  it('bookland-префікс 978 і 979 не змінюють унікальність у межах одного namespace', () => {
    const a = uniqueIsbn13('bookland-mix', '978')
    const b = uniqueIsbn13('bookland-mix', '979')

    expect(a).not.toBe(b)
    expect(a.startsWith('978')).toBe(true)
    expect(b.startsWith('979')).toBe(true)
  })

  it('хеш-регіон стабільний між викликами для одного namespace', () => {
    // Лічильник змінюється, але регіон лишається функцією namespace, а не часу чи pid.
    const value = uniqueIsbn13('deterministic-check')
    const region = value.slice(3, 9)

    const again = uniqueIsbn13('deterministic-check')
    const regionAgain = again.slice(3, 9)

    expect(region).toBe(regionAgain)
  })

  it('реальні namespace e2e-файлів, що використовують helper, не колізять', () => {
    const REAL_NAMESPACES = [
      'catalog-lookup',
      'catalog-lookup-rate-limit',
      'catalog-search-candidates',
      'catalog-canonical',
      'catalog',
      // Stage 8f-2: CSV-імпорт.
      'library-import-preview',
      'library-import-rows',
      'library-import-staleness',
    ]

    const first = REAL_NAMESPACES.map((namespace) => uniqueIsbn13(namespace))

    expect(new Set(first).size).toBe(REAL_NAMESPACES.length)
  })

  it('вичерпаний лічильник (999 на namespace) кидає, а не тихо переповнюється', () => {
    const namespace = 'exhausted-counter'

    for (let index = 0; index < 999; index += 1) uniqueIsbn13(namespace)

    expect(() => uniqueIsbn13(namespace)).toThrow(/вичерпано лічильник/)
  })
})

/**
 * CI-регресія: `./helpers/unique-isbn.ts` раніше жив у `auth.helpers.ts`,
 * який імпортує `AppModule` для `createTestApp()`. Цей spec запускається
 * `apps/api/jest.config.js` (unit-конфіг, без `DATABASE_URL`/
 * `DIRECT_DATABASE_URL`), і `AppModule` → `ConfigModule.forRoot({ validate:
 * validateEnv })` валить Jest worker ще до першого тесту.
 *
 * Статична перевірка тексту джерела, а не resolve графа модулів: доводить
 * рівно те, що потрібно (жоден import-специфікатор у файлі не веде на
 * Nest/Prisma/AppModule/auth-helpers), без побудови повноцінного
 * dependency-checker.
 */
describe('pure module boundary (regression proof)', () => {
  it('helpers/unique-isbn.ts не імпортує AppModule, Nest testing, Prisma чи auth.helpers', () => {
    const source = readFileSync(join(__dirname, 'helpers/unique-isbn.ts'), 'utf8')
    const importSpecifiers = [...source.matchAll(/^import\s+.*?from\s+['"]([^'"]+)['"]/gm)].map(
      (match) => match[1],
    )

    const forbidden = /app\.module|@nestjs|prisma|auth\.helpers|config\/env\.validation/i

    for (const specifier of importSpecifiers) {
      expect(specifier).not.toMatch(forbidden)
    }
  })
})
