import type { Edition, Work, WorkAuthor } from '@bookswap/shared'
import { EDITION_FORMAT_LABELS } from '@/app/lib/labels'
import { languageName } from '@/app/lib/language-names'
import type { AddResultFact } from './add-result-view'
import { TEXT_KIND_LABELS } from './manual-form'

/** What an unknown value reads as: said plainly, never guessed. */
export const UNKNOWN_VALUE = 'Не вказано'

export interface EditionRefineFacts {
  work: AddResultFact[]
  edition: AddResultFact[]
}

function fact(label: string, value: string | number | null): AddResultFact {
  return { label, value: value === null || value === '' ? UNKNOWN_VALUE : String(value) }
}

/**
 * «Уточнити дані» of an edition already in the catalog (BS-114): every field of the work and of the
 * edition as text, in the order and with the names of the manual form. The work's first publication
 * and the edition's year stay separate rows.
 */
export function editionRefineFacts(
  work: Work,
  authors: readonly WorkAuthor[],
  edition: Edition,
): EditionRefineFacts {
  return {
    work: [
      fact('Назва', work.title),
      fact('Автори', authors.map((author) => author.name).join(', ')),
      fact('Мова оригіналу', work.origLang === null ? null : languageName(work.origLang)),
      fact('Рік першого видання', work.firstPubYear),
    ],
    edition: [
      fact('Мова видання', edition.lang === null ? null : languageName(edition.lang)),
      fact('Це переклад?', TEXT_KIND_LABELS[edition.textKind]),
      // A translator is asked about only for a translation: an original has none to be unknown.
      ...(edition.textKind === 'TRANSLATION' ? [fact('Перекладач', edition.translator)] : []),
      fact('ISBN', edition.isbn13),
      fact('Видавництво', edition.publisher),
      fact('Рік видання', edition.year),
      fact('Кількість сторінок', edition.pageCount),
      fact('Палітурка', edition.format === null ? null : EDITION_FORMAT_LABELS[edition.format]),
    ],
  }
}
