import { ownBookResponseSchema, type OwnBookResponse, type OwnCopy } from '@bookswap/shared'

/** A valid `GET /me/library/copies/:id` answer; `copy` overrides tweak the owner's copy only. */
export function ownBookFixture(copy: Partial<OwnCopy> = {}): OwnBookResponse {
  return ownBookResponseSchema.parse({
    copy: {
      id: 'copy-1',
      status: 'AVAILABLE',
      visibility: 'FRIENDS',
      condition: 'GOOD',
      note: 'з автографом',
      acquiredAt: '2026-03-01',
      createdAt: '2026-03-01T10:00:00.000Z',
      isHome: true,
      holder: null,
      activeLoan: null,
      pendingRequestCount: 0,
      ...copy,
    },
    edition: {
      id: 'edition-1',
      workId: 'work-1',
      translationId: null,
      publisher: 'А-БА-БА-ГА-ЛА-МА-ГА',
      year: 2019,
      isbn13: null,
      pageCount: null,
      coverUrl: null,
      format: 'HARDCOVER',
      textKind: 'ORIGINAL',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
    work: {
      id: 'work-1',
      title: 'Кобзар',
      origLang: 'uk',
      firstPubYear: 1840,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [
      { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 },
    ],
  })
}
