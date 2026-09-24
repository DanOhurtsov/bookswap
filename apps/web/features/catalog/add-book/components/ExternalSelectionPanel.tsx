import type { ExternalSearchResult, Translation } from '@bookswap/shared'
import type { ExternalSelection } from '../model/external-selection'
import { LocalResultCard } from './LocalResultCard'

type ExternalSelectionPanelProps = {
  selection: ExternalSelection
  onUseEdition: (workId: string, title: string, editionId: string) => void
  onUseWork: (
    workId: string,
    title: string,
    result: ExternalSearchResult,
    translations: Translation[],
  ) => void
  onCreateAnyway: (result: ExternalSearchResult) => void
  onRetry: (result: ExternalSearchResult) => void
  onCancel: () => void
}

/**
 * The step between "picked an external record" and "fills in the form".
 *
 * It exists purely for §6.3 step 2: before creating a new `Work`, ask whether
 * it is not already there. An external choice does not waive that check — it
 * makes it more necessary: a book just found in Google Books may well already
 * sit in our catalog under a slightly different title.
 *
 * The panel NEVER chooses for the user. Even an exact ISBN match is an offer
 * with a button, not an automatic substitution: §6.3 leaves the decision to the
 * person, and "create anyway" is available in every state, including the failed
 * check. A duplicate is worse than an extra question, but a blocked user is
 * worse than both.
 */
export function ExternalSelectionPanel({
  selection,
  onUseEdition,
  onUseWork,
  onCreateAnyway,
  onRetry,
  onCancel,
}: ExternalSelectionPanelProps) {
  const { result } = selection

  const createAnyway = (label: string) => (
    <button
      type="button"
      onClick={() => {
        onCreateAnyway(result)
      }}
    >
      {label}
    </button>
  )

  const cancel = (
    <button type="button" className="button--ghost" onClick={onCancel}>
      Обрати інший запис
    </button>
  )

  if (selection.status === 'checking') {
    return (
      <section>
        <p className="lede">Обрано: {result.title}</p>
        <p className="status status--pending">Перевіряю, чи така книжка вже є у BookSwap…</p>
      </section>
    )
  }

  // The check did not happen — but that is our problem, not a reason to stop
  // the person. We say plainly that a duplicate is not ruled out, and offer
  // all three exits: try again, create anyway, or pick something else.
  if (selection.status === 'failed') {
    return (
      <section>
        <p className="lede">Обрано: {result.title}</p>
        <p className="status status--error" role="status">
          Не вдалося перевірити, чи така книжка вже є у BookSwap ({selection.message}). Дублікат не
          виключений.
        </p>
        <p className="form__aside">
          <button
            type="button"
            onClick={() => {
              onRetry(result)
            }}
          >
            Повторити перевірку
          </button>{' '}
          {createAnyway('Усе одно створити новий твір')} {cancel}
        </p>
      </section>
    )
  }

  return (
    <section>
      <p className="lede">Обрано: {result.title}</p>

      <p className={selection.check.matchedBy === 'ISBN' ? 'status status--pending' : 'empty'}>
        {selection.check.matchedBy === 'ISBN'
          ? 'Видання з таким ISBN уже є у BookSwap. Додайте свій примірник до нього, а не створюйте копію.'
          : 'Схожі твори вже є у BookSwap. Якщо це одна з цих книжок — оберіть її.'}
      </p>

      <ul className="books">
        {selection.check.candidates.map((candidate) => (
          <LocalResultCard
            key={candidate.work.id}
            candidate={candidate}
            {...(result.isbn13 === undefined ? {} : { searchedIsbn: result.isbn13 })}
            onUseEdition={(editionId) => {
              onUseEdition(candidate.work.id, candidate.work.title, editionId)
            }}
            // The work's own translations travel with the choice: without them
            // `TranslationStep` shows no existing ones and the user adds a
            // second translation for a language the work already has.
            onUseWork={() => {
              onUseWork(candidate.work.id, candidate.work.title, result, candidate.translations)
            }}
          />
        ))}
      </ul>

      <p className="form__aside">
        Це інша книжка? {createAnyway('Створити новий твір')} {cancel}
      </p>
    </section>
  )
}
