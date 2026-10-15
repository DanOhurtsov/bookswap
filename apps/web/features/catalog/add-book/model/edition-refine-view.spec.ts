import type { Edition } from '@bookswap/shared'
import { editionRefineFacts, UNKNOWN_VALUE } from './edition-refine-view'

const WORK = {
  id: 'w-1',
  title: 'Кобзар',
  origLang: null,
  firstPubYear: 1840,
  description: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

const EDITION: Edition = {
  id: 'e-1',
  workId: 'w-1',
  translationId: null,
  publisher: null,
  year: 2019,
  isbn13: '9783161484100',
  pageCount: null,
  coverUrl: null,
  format: null,
  textKind: 'UNKNOWN',
  lang: 'uk',
  translator: null,
  revision: 3,
}

describe('editionRefineFacts', () => {
  it('every field as text; the unknown says so instead of a guess', () => {
    expect(editionRefineFacts(WORK, [], EDITION)).toEqual({
      work: [
        { label: 'Назва', value: 'Кобзар' },
        { label: 'Автори', value: UNKNOWN_VALUE },
        { label: 'Мова оригіналу', value: UNKNOWN_VALUE },
        { label: 'Рік першого видання', value: '1840' },
      ],
      edition: [
        { label: 'Мова видання', value: 'українська' },
        { label: 'Це переклад?', value: 'Не знаю' },
        { label: 'ISBN', value: '9783161484100' },
        { label: 'Видавництво', value: UNKNOWN_VALUE },
        { label: 'Рік видання', value: '2019' },
        { label: 'Кількість сторінок', value: UNKNOWN_VALUE },
        { label: 'Палітурка', value: UNKNOWN_VALUE },
      ],
    })
  })

  it('a translation also shows its translator', () => {
    const facts = editionRefineFacts(WORK, [], {
      ...EDITION,
      textKind: 'TRANSLATION',
      translator: 'Перекладач',
    })

    expect(facts.edition).toContainEqual({ label: 'Перекладач', value: 'Перекладач' })
  })
})
