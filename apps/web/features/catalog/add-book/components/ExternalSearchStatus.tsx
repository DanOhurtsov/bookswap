import type { ExternalSearchSourceReport } from '@bookswap/shared'
import type { ExternalSearchState } from '../model/external-search-state'
import { SOURCE_LABELS } from './ExternalResultCard'

type ExternalSearchStatusProps = {
  state: ExternalSearchState
}

/**
 * Why a source produced nothing, in the user's words.
 *
 * `RATE_LIMITED` reads differently from `ERROR` on purpose: it is our own
 * outbound throttle, not an outage, so the honest advice is "try again shortly"
 * rather than "the catalog is down". Telling someone a healthy service is
 * broken sends them to check the wrong thing.
 */
function describeUnavailable(report: ExternalSearchSourceReport): string {
  const label = SOURCE_LABELS[report.source]

  if (report.status === 'TIMEOUT') return `${label} не відповіла вчасно`
  if (report.status === 'RATE_LIMITED') {
    return `${label} пропущено, щоб не перевищити ліміт звернень — спробуйте за хвилину`
  }

  return `${label} зараз недоступна`
}

/**
 * A single line beside the results — never a section of its own.
 *
 * External search is slower than the local one and may fail on its own, but the
 * results already on screen do not depend on it. So its state is reported
 * compactly next to the list instead of wrapping it: nothing here hides,
 * replaces or delays a result the person can already act on.
 *
 * Silence has meaning too. When every source answered, this renders nothing —
 * a line saying "everything is fine" would be noise on the ordinary path.
 */
export function ExternalSearchStatus({ state }: ExternalSearchStatusProps) {
  if (state.status === 'idle') return null

  if (state.status === 'loading') {
    return <p className="status status--pending">Шукаю ще в Open Library та Google Books…</p>
  }

  if (state.status === 'failed') {
    return <p className="status status--pending">Зовнішні каталоги не відповіли: {state.message}</p>
  }

  const unavailable = state.sources.filter((report) => report.status !== 'OK')

  if (unavailable.length === 0) return null

  // An unavailable source is named explicitly, including when the others did
  // find something. Without this line "one book was found" would look like a
  // complete answer, though half the catalogs were never asked.
  return (
    <p className="status status--pending">
      {unavailable.map(describeUnavailable).join('; ')}. Список може бути неповним.
    </p>
  )
}
