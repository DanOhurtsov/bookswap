import { createTestPrismaClient, truncateAll } from './test-database'
import type { PrismaClient } from '../../src/generated/prisma/client'

/**
 * Перевіряє те, чого немає в Prisma Schema і що тому легко загубити при правках
 * міграцій: розширення §4.9 і три індекси, дописані/спеціалізовані вручну.
 */
describe('обʼєкти схеми поза Prisma Schema', () => {
  let prisma: PrismaClient

  beforeAll(() => {
    prisma = createTestPrismaClient()
  })

  beforeEach(async () => {
    await truncateAll(prisma)
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('розширення pg_trgm і unaccent створені (§4.9)', async () => {
    const rows = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent')
    `

    expect(rows.map((row) => row.extname).sort()).toEqual(['pg_trgm', 'unaccent'])
  })

  it('GIN-індекси для fuzzy-пошуку існують і використовують gin_trgm_ops', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('work_title_trgm_idx', 'author_name_trgm_idx')
      ORDER BY indexname
    `

    expect(rows).toHaveLength(2)
    // Обидва — по нормалізованій колонці: similarity() регістрозалежна, тож
    // індекс по сирому `name` не знаходив би «ґреґорі» в «Ґреґорі Робертс».
    expect(rows[0]?.indexdef).toMatch(/USING gin \("nameNorm" gin_trgm_ops\)/)
    expect(rows[1]?.indexdef).toMatch(/USING gin \("titleNorm" gin_trgm_ops\)/)
  })

  /**
   * Функція нормалізації — єдине визначення «lower + unaccent» (§4.4) на весь
   * застосунок: нею заповнюються `titleNorm` і `nameNorm`, нею ж нормалізується
   * пошуковий запит. Якщо міграцію колись перепишуть без неї, ламатися має тут,
   * а не мовчазним «пошук нічого не знаходить».
   */
  it('bookswap_norm існує, IMMUTABLE і робить lower + unaccent', async () => {
    // `provolatile` має внутрішній тип "char", який Prisma не десеріалізує, —
    // звідси явний ::text.
    const [volatility] = await prisma.$queryRaw<{ provolatile: string }[]>`
      SELECT provolatile::text AS provolatile FROM pg_proc WHERE proname = 'bookswap_norm'
    `

    // 'i' = IMMUTABLE. Без цього функцію не можна класти в індексний вираз, а
    // сам unaccent/1 лише STABLE — тому в тілі стоїть двоаргументний виклик.
    expect(volatility?.provolatile).toBe('i')

    const [normalized] = await prisma.$queryRaw<{ value: string }[]>`
      SELECT bookswap_norm('Café Zürich Їжак') AS value
    `

    // Латинська діакритика знімається, українські літери лишаються собою:
    // саме через це нормалізація живе в БД, а не в TS (там NFD зробив би «іжак»).
    expect(normalized?.value).toBe('cafe zurich їжак')
  })

  it('similarity() ловить назву з друкарською помилкою (§6.3, крок 2)', async () => {
    const author = await prisma.user.create({
      data: { email: 'trgm@example.com', passwordHash: 'x', displayName: 'Пошук' },
    })

    await prisma.work.create({
      data: {
        title: 'Шантарам',
        titleNorm: 'шантарам',
        origLang: 'en',
        createdById: author.id,
      },
    })

    // Саме той поріг, що в §6.3: без pg_trgm цей запит не виконався б узагалі,
    // а з ним «шантрам» без літери все одно знаходить наявний твір.
    const found = await prisma.$queryRaw<{ title: string }[]>`
      SELECT title FROM "Work" WHERE similarity("titleNorm", 'шантрам') > 0.3
    `

    expect(found).toEqual([{ title: 'Шантарам' }])
  })

  /**
   * Пошук використовує оператор `%` (єдиний, що лягає на GIN-індекс) і фіксує
   * поріг на транзакцію. Перевіряється саме поведінка `set_config(..., true)`:
   * якщо вона перестане працювати, поріг мовчки з'їде на серверний дефолт.
   */
  it('поріг схожості фіксується на транзакцію (§6.3: 0.3)', async () => {
    const [row] = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('pg_trgm.similarity_threshold', '0.3', true)`

      return tx.$queryRaw<{ matched: boolean; threshold: string }[]>`
        SELECT 'шантарам' % 'шантрам' AS matched,
               current_setting('pg_trgm.similarity_threshold') AS threshold
      `
    })

    expect(row?.matched).toBe(true)
    expect(row?.threshold).toBe('0.3')
  })

  it('one_active_loan_per_copy — унікальний частковий індекс на трьох ексклюзивних статусах (§5.3, M5)', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'one_active_loan_per_copy'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0]?.indexdef).toMatch(/"copyId"/)
    expect(rows[0]?.indexdef).toMatch(/APPROVED/)
    expect(rows[0]?.indexdef).toMatch(/HANDED_OVER/)
    expect(rows[0]?.indexdef).toMatch(/PENDING_CONFIRMATION/)
    // REQUESTED навмисно не входить: §5.2 дозволяє кільком людям одночасний запит.
    expect(rows[0]?.indexdef).not.toMatch(/REQUESTED/)
  })

  /**
   * R5 (docs/plan/stage-7.md, підетап 7g). Індекс частковий саме тому, що мерж
   * двох `Work` може звести дві рецензії однієї людини на один твір: програшна
   * отримує `archivedAt` і випадає з-під обмеження, не зникаючи з бази.
   *
   * Перевіряється й ВІДСУТНІСТЬ суцільного `Review_workId_userId_key`: якби його
   * колись повернули, він забороняв би рівно те, заради чого заводився частковий,
   * і мерж почав би падати на конфліктних рецензіях.
   */
  it('one_active_review_per_work_user — частковий unique замість суцільного (R5)', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE indexname IN ('one_active_review_per_work_user', 'Review_workId_userId_key')
    `

    expect(rows.map((row) => row.indexname)).toEqual(['one_active_review_per_work_user'])
    expect(rows[0]?.indexdef).toMatch(/CREATE UNIQUE INDEX/)
    expect(rows[0]?.indexdef).toMatch(/"workId", "userId"/)
    expect(rows[0]?.indexdef).toMatch(/WHERE \("archivedAt" IS NULL\)/)
  })

  it('CHECK-обмеження Friendship існують (§4.3, §5.3.5)', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"Friendship"'::regclass AND contype = 'c'
      ORDER BY conname
    `

    expect(rows.map((row) => row.conname)).toEqual([
      'friendship_ab_ordered',
      'friendship_block_author_valid',
    ])

    // Порядок пари — строга нерівність, інакше пара «сам із собою» пройшла б.
    expect(rows[0]?.definition).toMatch(/"userAId" < "userBId"/)

    // Перевірка автора блокування мусить лишатися fail-closed: CASE замість
    // кон'юнкції порівнянь, і явна перевірка належності до пари. Наївне
    // `blockedById IN (userAId, userBId)` для NULL дало б NULL, і рядок без
    // автора мовчки пройшов би — див. коментар у міграції.
    expect(rows[1]?.definition).toMatch(/CASE/)
    expect(rows[1]?.definition).toMatch(/"blockedById" IS NOT NULL/)
    expect(rows[1]?.definition).toMatch(/"blockedById" = "userAId"/)
    expect(rows[1]?.definition).toMatch(/"blockedById" = "userBId"/)
    expect(rows[1]?.definition).toMatch(/"blockedById" IS NULL/)
  })

  it('CHECK-обмеження Loan існує (§5.3.4)', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"Loan"'::regclass AND contype = 'c'
      ORDER BY conname
    `

    // Stage 10 (10a) додав два CHECK-и; `loan_borrower_not_owner` не змінено.
    expect(rows.map((row) => row.conname)).toEqual([
      'loan_borrower_kind_valid',
      'loan_borrower_not_owner',
      'loan_requested_has_request_time',
    ])
    expect(rows[1]?.definition).toMatch(/"borrowerId" <> "ownerId"/)
  })

  /**
   * §5.3.2 в ослабленій формі: три імплікації замість еквівалентності.
   *
   * Дослівне «AVAILABLE ⟺ holder = owner» суперечить §5.1 і §4.5 — `RESERVED` і
   * `UNAVAILABLE` теж означають книжку вдома. Тест фіксує саме ту форму, яку ми
   * свідомо обрали, щоб її не «виправили» назад до еквівалентності.
   */
  it('CHECK-обмеження Copy тримають інваріант §5.3.2 трьома імплікаціями', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"Copy"'::regclass AND contype = 'c'
      ORDER BY conname
    `

    expect(rows.map((row) => row.conname)).toEqual([
      'copy_available_is_home',
      'copy_away_is_lent_or_unavailable',
      'copy_lent_out_is_away',
      // Stage 10 (10a, T1-a): тримач — користувач або контакт, не обидва.
      'copy_single_holder',
    ])

    // 1. Вільна книжка завжди вдома.
    expect(rows[0]?.definition).toMatch(/AVAILABLE/)
    expect(rows[0]?.definition).toMatch(/"currentHolderId" = "ownerId"/)

    // 2. Не вдома — лише LENT_OUT або UNAVAILABLE. RESERVED сюди не входить, тож
    //    «домовлено» автоматично означає «ще вдома» (§5.2) — ЄДИНИЙ виняток (Stage 10, 10i.1):
    //    RESERVED поза домом дозволений лише тоді, коли книжку тримає контакт-гість
    //    (`heldByContactId IS NOT NULL`) — «фізично передано, гість ще не підтвердив».
    expect(rows[1]?.definition).toMatch(/LENT_OUT/)
    expect(rows[1]?.definition).toMatch(/UNAVAILABLE/)
    expect(rows[1]?.definition).toMatch(
      /RESERVED'::"CopyStatus"\) AND \("heldByContactId" IS NOT NULL\)/,
    )

    // 3. Зворотний бік: LENT_OUT означає, що книжка фізично в іншої людини.
    //    Stage 10: «не вдома» = NOT(home), де home враховує NULL-тримача (COALESCE) і контакт.
    expect(rows[2]?.definition).toMatch(/NOT/)
    expect(rows[2]?.definition).toMatch(/COALESCE/)
    expect(rows[2]?.definition).toMatch(/"heldByContactId" IS NULL/)
    expect(rows[3]?.definition).toMatch(/"currentHolderId" IS NULL/)
  })

  it('Stage 10 (10i.1): CHECK-обмеження ExternalBorrower і GuestLoanConfirmation існують', async () => {
    const borrower = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"ExternalBorrower"'::regclass AND contype = 'c'
      ORDER BY conname
    `

    expect(borrower.map((row) => row.conname)).toEqual([
      'external_borrower_guest_identity_all_or_none',
    ])
    expect(borrower[0]?.definition).toMatch(/"guestNickname" IS NULL/)
    expect(borrower[0]?.definition).toMatch(/"guestEmailVerifiedAt" IS NULL/)

    const confirmation = await prisma.$queryRaw<{ conname: string; definition: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"GuestLoanConfirmation"'::regclass AND contype = 'c'
      ORDER BY conname
    `

    expect(confirmation.map((row) => row.conname)).toEqual(['guest_loan_confirmation_resolved_at'])
    expect(confirmation[0]?.definition).toMatch(/"resolvedAt" IS NULL/)
  })

  it('blockedById має зовнішній ключ на User — від нього залежить право (§6.2)', async () => {
    const rows = await prisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = '"Friendship"'::regclass
        AND contype = 'f'
        AND conname = 'Friendship_blockedById_fkey'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]?.definition).toMatch(/REFERENCES "User"\(id\)/)
    expect(rows[0]?.definition).toMatch(/ON DELETE CASCADE/)
  })
})
