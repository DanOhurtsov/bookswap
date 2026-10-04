import { editionCorrectionFormSchema } from './edition-form'
import { workCorrectionFormSchema } from './work-form'

/**
 * Невідомі `origLang` і `format` у формах виправлення: порожнє значення валідне й означає «не змінювати».
 * Інакше збереження назви твору чи видавництва вимагало б ВИГАДАТИ мову чи палітурку.
 */
describe('форми виправлення з невідомими даними', () => {
  const work = {
    title: 'Назва',
    origLang: '',
    firstPubYear: null,
    description: null,
    authors: [{ name: 'Автор' }],
    expectedRevision: 1,
  }
  const edition = {
    translationId: null,
    textKind: 'UNKNOWN',
    lang: null,
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: '',
    expectedRevision: 1,
  }

  it('твір: порожня мова валідна, неіснуюча — ні', () => {
    expect(workCorrectionFormSchema.safeParse(work).success).toBe(true)
    expect(workCorrectionFormSchema.safeParse({ ...work, origLang: 'uk' }).success).toBe(true)
    expect(workCorrectionFormSchema.safeParse({ ...work, origLang: 'zz' }).success).toBe(false)
  })

  it('видання: порожній формат валідний, невідомий — ні', () => {
    expect(editionCorrectionFormSchema.safeParse(edition).success).toBe(true)
    expect(editionCorrectionFormSchema.safeParse({ ...edition, format: 'POCKET' }).success).toBe(
      true,
    )
    expect(editionCorrectionFormSchema.safeParse({ ...edition, format: 'GLOSSY' }).success).toBe(
      false,
    )
  })
})
