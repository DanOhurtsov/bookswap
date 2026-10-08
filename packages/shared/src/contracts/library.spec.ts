import { COPY_STATUS } from '../domain/copy'
import {
  addCopyRequestSchema,
  borrowedCopySchema,
  libraryQueryRequestSchema,
  ownBookResponseSchema,
  ownCopySchema,
  updateCopyRequestSchema,
  visibleCopySchema,
} from './library'

const owner = { id: 'user-1', displayName: 'Марта', avatarUrl: null }

const rawCopy = {
  id: 'copy-1',
  status: 'AVAILABLE',
  visibility: 'FRIENDS',
  condition: 'GOOD',
  note: 'кавова пляма на 200-й',
  acquiredAt: '2026-03-01',
  createdAt: '2026-03-01T10:00:00.000Z',
  isHome: true,
  holder: null,
  owner,
  // §6.5: контекст позичання. `AVAILABLE` не означає «ви ще не просили» — за §5.1
  // запит примірника не змінює, тож стан кнопки тримає саме лоан.
  activeLoan: null,
  myActiveLoan: null,
  pendingRequestCount: 0,
  // §6.5: capability рахує сервер — див. `canRequest` у контракті.
  canRequest: true,
  expectedReturnAt: null,
}

describe('addCopyRequestSchema', () => {
  it('вимагає лише editionId — решта має дефолти в базі', () => {
    expect(addCopyRequestSchema.parse({ editionId: 'edition-1' })).toEqual({
      editionId: 'edition-1',
    })
  })

  it('не має поля «кількість»: кожен фізичний примірник — окремий Copy (§3)', () => {
    const parsed = addCopyRequestSchema.parse({ editionId: 'edition-1', quantity: 3 })

    expect(parsed).not.toHaveProperty('quantity')
  })

  it('приймає дату придбання без часу', () => {
    expect(
      addCopyRequestSchema.parse({ editionId: 'e-1', acquiredAt: '2026-03-01' }).acquiredAt,
    ).toBe('2026-03-01')
    expect(
      addCopyRequestSchema.safeParse({ editionId: 'e-1', acquiredAt: '2026-03-01T10:00:00.000Z' })
        .success,
    ).toBe(false)
  })

  it.each(['MANUAL', 'BARCODE'] as const)('приймає entryMethod=%s', (entryMethod) => {
    expect(addCopyRequestSchema.parse({ editionId: 'e-1', entryMethod }).entryMethod).toBe(
      entryMethod,
    )
  })

  it.each(['CSV', 'OCR'])('відхиляє client entryMethod=%s', (entryMethod) => {
    expect(addCopyRequestSchema.safeParse({ editionId: 'e-1', entryMethod }).success).toBe(false)
  })
})

describe('updateCopyRequestSchema', () => {
  it('вимагає хоча б одне поле', () => {
    expect(updateCopyRequestSchema.safeParse({}).success).toBe(false)
  })

  it('дозволяє прибрати нотатку явним null', () => {
    expect(updateCopyRequestSchema.parse({ note: null }).note).toBeNull()
  })

  it.each(['AVAILABLE', 'UNAVAILABLE'])('приймає status=%s — це осі власника', (status) => {
    expect(updateCopyRequestSchema.parse({ status }).status).toBe(status)
  })

  it.each(['RESERVED', 'LENT_OUT'])(
    'відхиляє status=%s: цим станом керує лише стейт-машина §5',
    (status) => {
      expect(updateCopyRequestSchema.safeParse({ status }).success).toBe(false)
    },
  )

  it('не дає перепризначити власника чи тримача', () => {
    const parsed = updateCopyRequestSchema.parse({
      note: 'нова нотатка',
      ownerId: 'user-2',
      currentHolderId: 'user-2',
    })

    expect(parsed).not.toHaveProperty('ownerId')
    expect(parsed).not.toHaveProperty('currentHolderId')
  })
})

describe('libraryQueryRequestSchema', () => {
  it.each([...COPY_STATUS])('фільтрує за status=%s', (status) => {
    expect(libraryQueryRequestSchema.parse({ status }).status).toBe(status)
  })

  it('усі фільтри опційні', () => {
    expect(libraryQueryRequestSchema.parse({})).toEqual({})
  })

  it('валідує мову як ISO 639-1', () => {
    expect(libraryQueryRequestSchema.safeParse({ lang: 'zz' }).success).toBe(false)
  })

  it('archived приймає лише true/false (рядки запиту)', () => {
    expect(libraryQueryRequestSchema.parse({ archived: 'true' }).archived).toBe('true')
    expect(libraryQueryRequestSchema.parse({ archived: 'false' }).archived).toBe('false')
    expect(libraryQueryRequestSchema.safeParse({ archived: 'yes' }).success).toBe(false)
  })
})

describe('проєкції примірника', () => {
  it('власник бачить нотатку й дату придбання', () => {
    const parsed = ownCopySchema.parse(rawCopy)

    expect(parsed.note).toBe('кавова пляма на 200-й')
    expect(parsed.acquiredAt).toBe('2026-03-01')
  })

  it('чужий примірник не несе приватних полів власника (§9)', () => {
    const parsed = visibleCopySchema.parse(rawCopy)

    expect(parsed).not.toHaveProperty('note')
    expect(parsed).not.toHaveProperty('acquiredAt')
    expect(parsed).not.toHaveProperty('visibility')
    expect(parsed).not.toHaveProperty('createdAt')
  })

  it('позичена мною книжка показує власника, але не його нотатки', () => {
    const parsed = borrowedCopySchema.parse(rawCopy)

    expect(parsed.owner).toEqual(owner)
    expect(parsed).not.toHaveProperty('note')
    expect(parsed).not.toHaveProperty('visibility')
  })

  it('гість бачить лише СВІЙ лоан, власник — ще й довжину черги (§6.5)', () => {
    // Скільки ще людей просить цю книжку — справа власника: `pendingRequestCount`
    // існує тільки в його проєкції.
    const withLoans = {
      ...rawCopy,
      activeLoan: { id: 'loan-1', status: 'APPROVED', counterpart: owner },
      myActiveLoan: { id: 'loan-2', status: 'REQUESTED' },
      pendingRequestCount: 3,
    }

    expect(ownCopySchema.parse(withLoans).pendingRequestCount).toBe(3)
    expect(visibleCopySchema.parse(withLoans)).not.toHaveProperty('pendingRequestCount')
    expect(visibleCopySchema.parse(withLoans)).not.toHaveProperty('activeLoan')
    expect(visibleCopySchema.parse(withLoans).myActiveLoan).toEqual({
      id: 'loan-2',
      status: 'REQUESTED',
    })
  })

  it('ексклюзивний лоан власника не буває REQUESTED — їх може бути кілька (§5.2)', () => {
    const withPending = {
      ...rawCopy,
      activeLoan: { id: 'loan-1', status: 'REQUESTED', counterpart: owner },
    }

    expect(ownCopySchema.safeParse(withPending).success).toBe(false)
  })

  it('canRequest — окреме поле, а не здогад із status (§6.5)', () => {
    // Примірник AVAILABLE, але капабіліті може бути false: `/users/:id/library`
    // за §9 бачить і сторонній, і власник, а запит дозволений лише другові.
    const refused = visibleCopySchema.parse({ ...rawCopy, canRequest: false })

    expect(refused.status).toBe('AVAILABLE')
    expect(refused.canRequest).toBe(false)
    expect(visibleCopySchema.safeParse({ ...rawCopy, canRequest: undefined }).success).toBe(false)
  })

  it('власна проєкція капабіліті не має: собі не позичають', () => {
    expect(ownCopySchema.parse(rawCopy)).not.toHaveProperty('canRequest')
  })

  it('expectedReturnAt — дата без часу й без жодного носія особи (§6.5)', () => {
    const lent = visibleCopySchema.parse({
      ...rawCopy,
      status: 'LENT_OUT',
      isHome: false,
      expectedReturnAt: '2026-06-12',
    })

    expect(lent.expectedReturnAt).toBe('2026-06-12')
    // Повний ISO не приймається: «о котрій годині повернути» не домовляються.
    expect(
      visibleCopySchema.safeParse({ ...rawCopy, expectedReturnAt: '2026-06-12T10:00:00.000Z' })
        .success,
    ).toBe(false)
  })

  it('через expectedReturnAt не проходить ані лоан, ані позичальник', () => {
    // Схема — остання лінія: навіть якщо мапер колись почне класти сюди обʼєкт,
    // контракт його не пропустить.
    for (const value of [
      { loanId: 'loan-1', dueAt: '2026-06-12' },
      { id: 'loan-1' },
      ['2026-06-12'],
    ]) {
      expect(visibleCopySchema.safeParse({ ...rawCopy, expectedReturnAt: value }).success).toBe(
        false,
      )
    }
  })

  it('лоан гостя не буває термінальним: історія — окремий ендпоінт', () => {
    for (const status of ['REJECTED', 'CANCELLED', 'RETURNED', 'LOST']) {
      expect(
        visibleCopySchema.safeParse({ ...rawCopy, myActiveLoan: { id: 'loan-2', status } }).success,
      ).toBe(false)
    }
  })
})

describe('ownBookResponseSchema', () => {
  const edition = {
    id: 'edition-1',
    workId: 'work-1',
    translationId: null,
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    textKind: 'ORIGINAL',
    lang: 'en',
    translator: null,
    revision: 1,
  }
  const work = {
    id: 'work-1',
    title: 'Шантарам',
    origLang: 'en',
    firstPubYear: null,
    description: null,
    createdAt: '2026-03-01T10:00:00.000Z',
    revision: 1,
  }
  const author = {
    id: 'author-1',
    name: 'Грегорі Робертс',
    nameLatin: null,
    role: 'AUTHOR',
    position: 0,
  }

  it('несе нотатку власника разом із каталожним контекстом примірника', () => {
    const parsed = ownBookResponseSchema.parse({
      copy: rawCopy,
      edition,
      work,
      authors: [author],
    })

    expect(parsed.copy.note).toBe('кавова пляма на 200-й')
    expect(parsed.work.id).toBe('work-1')
    expect(parsed.authors).toHaveLength(1)
  })

  it('не приймає відповідь без примірника: сторінка адресує саме його', () => {
    expect(ownBookResponseSchema.safeParse({ edition, work, authors: [] }).success).toBe(false)
  })
})
