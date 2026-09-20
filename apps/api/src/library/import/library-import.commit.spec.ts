import type {
  LibraryImportResolvedCatalog,
  LibraryImportRowRecord,
  LibraryImportRowResolution,
  LibraryImportRowStatus,
} from '@bookswap/shared'
import {
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_DEFAULTS,
  libraryImportCsvCellsSchema,
} from '@bookswap/shared'
import { assessLibraryImportCommit, exceedsCopyCap } from './library-import.commit'

/**
 * Stage 8g (R6c): the rules a draft is judged by, with no database in sight.
 *
 * These are the same answers `readiness.blockers` shows the owner and the same
 * ones the commit endpoint refuses with — the point of the function being pure
 * is that both can be pinned here rather than only through an HTTP round trip.
 */

const ISBN_A = '9780306406157'
const ISBN_B = '9783161484100'

function catalog(overrides: Partial<LibraryImportResolvedCatalog['work']> = {}) {
  return {
    work: {
      title: 'Шантарам',
      authors: ['Ґреґорі Девід Робертс'],
      origLang: 'en',
      firstPubYear: 2003,
      ...overrides,
    },
    translation: null,
    edition: {
      isbn13: ISBN_A,
      publisher: 'Рідна мова',
      year: 2016,
      pageCount: 800,
      coverUrl: null,
      format: 'PAPERBACK' as const,
    },
  }
}

function row(input: {
  rowNumber: number
  status: LibraryImportRowStatus
  isbn13?: string
  quantity?: number
  resolution?: LibraryImportRowResolution | null
}): LibraryImportRowRecord {
  const isbn13 = input.isbn13 ?? ISBN_A
  // Parsed, not cast: the fixture is held to the same contract the API stores,
  // so a drifted fixture fails here instead of quietly testing a shape nothing
  // ever produces.
  const cells = libraryImportCsvCellsSchema.parse(
    Object.fromEntries(LIBRARY_IMPORT_CSV_HEADER.map((column) => [column, ''])),
  )

  return {
    rowNumber: input.rowNumber,
    status: input.status,
    payload: {
      cells: { ...cells, isbn13 },
      values: {
        isbn13,
        format: LIBRARY_IMPORT_DEFAULTS.format,
        condition: LIBRARY_IMPORT_DEFAULTS.condition,
        visibility: LIBRARY_IMPORT_DEFAULTS.visibility,
        quantity: input.quantity ?? 1,
      },
      errors: [],
      resolution: input.resolution ?? null,
      rejectedCells: {},
      rowVersion: `v${String(input.rowNumber)}`,
    },
  }
}

const existingEdition: LibraryImportRowResolution = {
  kind: 'EXISTING_EDITION',
  editionId: 'edition-1',
  workId: 'work-1',
}

function createChain(workId: string | null, overrides = {}): LibraryImportRowResolution {
  return { kind: 'CREATE_CHAIN', workId, catalog: { ...catalog(), ...overrides } }
}

describe('assessLibraryImportCommit', () => {
  it('не дає комітити, поки є рядки без рішення, і називає саме їх', () => {
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_EXISTING_EDITION', resolution: existingEdition }),
      row({ rowNumber: 2, status: 'NEEDS_REVIEW' }),
      row({ rowNumber: 3, status: 'INVALID' }),
    ])

    expect(blockers).toContainEqual({ reason: 'ROWS_UNRESOLVED', rowNumbers: [2, 3] })
  })

  it('не дає комітити, коли всі рядки пропущено', () => {
    const { blockers, plan } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'SKIPPED' }),
      row({ rowNumber: 2, status: 'SKIPPED' }),
    ])

    expect(blockers).toEqual([{ reason: 'NOTHING_TO_IMPORT' }])
    expect(plan.copyCount).toBe(0)
  })

  it('пропущений рядок не додає примірників і не потрапляє в план', () => {
    const { plan } = assessLibraryImportCommit([
      row({
        rowNumber: 1,
        status: 'READY_EXISTING_EDITION',
        quantity: 2,
        resolution: existingEdition,
      }),
      row({ rowNumber: 2, status: 'SKIPPED', isbn13: ISBN_B, quantity: 9 }),
    ])

    expect(plan.copyCount).toBe(2)
    expect(plan.copies.map((copy) => copy.rowNumber)).toEqual([1])
  })

  it('однаковий ISBN з однаковим рішенням дає одну chain і суму quantity', () => {
    const { blockers, plan } = assessLibraryImportCommit([
      row({
        rowNumber: 1,
        status: 'READY_CREATE_CHAIN',
        quantity: 2,
        resolution: createChain(null),
      }),
      row({
        rowNumber: 2,
        status: 'READY_CREATE_CHAIN',
        quantity: 3,
        resolution: createChain(null),
      }),
    ])

    expect(blockers).toEqual([])
    expect(plan.chains).toHaveLength(1)
    expect(plan.chains[0]?.rowNumbers).toEqual([1, 2])
    // Copy rows stay separate: each keeps its own quantity, and later its own
    // condition, visibility and private note (R6c).
    expect(plan.copies).toHaveLength(2)
    expect(plan.copyCount).toBe(5)
  })

  it('однаковий ISBN із різними metadata — конфлікт, а не мовчазний вибір', () => {
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_CREATE_CHAIN', resolution: createChain(null) }),
      row({
        rowNumber: 2,
        status: 'READY_CREATE_CHAIN',
        resolution: createChain(null, { work: { ...catalog().work, title: 'Інша назва' } }),
      }),
    ])

    expect(blockers).toContainEqual({ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: [1, 2] })
  })

  it('однаковий ISBN і однакові metadata, але різні обрані Work — теж конфлікт', () => {
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_CREATE_CHAIN', resolution: createChain('work-7') }),
      row({ rowNumber: 2, status: 'READY_CREATE_CHAIN', resolution: createChain('work-9') }),
    ])

    expect(blockers).toContainEqual({ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: [1, 2] })
  })

  it('«новий Work» проти «наявного Work» — конфлікт навіть за однакових metadata', () => {
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_CREATE_CHAIN', resolution: createChain(null) }),
      row({ rowNumber: 2, status: 'READY_CREATE_CHAIN', resolution: createChain('work-7') }),
    ])

    expect(blockers).toContainEqual({ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: [1, 2] })
  })

  it('той самий ISBN, де один рядок посилається на наявне видання, а другий створює нове', () => {
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_EXISTING_EDITION', resolution: existingEdition }),
      row({ rowNumber: 2, status: 'READY_CREATE_CHAIN', resolution: createChain(null) }),
    ])

    expect(blockers).toContainEqual({ reason: 'CONFLICTING_EDITION_ROWS', rowNumbers: [1, 2] })
  })

  it('різні ISBN одного твору лишаються окремими chain — за назвою не об’єднуємо', () => {
    const { blockers, plan } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_CREATE_CHAIN', resolution: createChain(null) }),
      row({
        rowNumber: 2,
        status: 'READY_CREATE_CHAIN',
        isbn13: ISBN_B,
        resolution: {
          kind: 'CREATE_CHAIN',
          workId: null,
          catalog: { ...catalog(), edition: { ...catalog().edition, isbn13: ISBN_B } },
        },
      }),
    ])

    expect(blockers).toEqual([])
    expect(plan.chains).toHaveLength(2)
    expect(plan.chains.every((chain) => chain.workId === null)).toBe(true)
  })

  it('порядок ключів у збереженому JSON не робить однакові рішення різними', () => {
    const reordered: LibraryImportRowResolution = {
      kind: 'CREATE_CHAIN',
      workId: null,
      catalog: JSON.parse(
        JSON.stringify(catalog(), ['edition', 'format', 'isbn13', 'work', 'title']),
      ) as LibraryImportResolvedCatalog,
    }

    // Same books, different key order — the comparison must not call that a
    // conflict, because one side of it always comes back through JSONB.
    const { blockers } = assessLibraryImportCommit([
      row({ rowNumber: 1, status: 'READY_CREATE_CHAIN', resolution: createChain(null) }),
      row({
        rowNumber: 2,
        status: 'READY_CREATE_CHAIN',
        resolution: { ...reordered, catalog: catalog() },
      }),
    ])

    expect(blockers).toEqual([])
  })
})

describe('exceedsCopyCap', () => {
  it('рівно 500 примірників ще дозволено, 501 — ні', () => {
    expect(exceedsCopyCap(500)).toBe(false)
    expect(exceedsCopyCap(501)).toBe(true)
  })
})
