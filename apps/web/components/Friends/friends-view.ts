import type { Friend, FriendRequest } from '@bookswap/shared'

/**
 * BS-154: what the friends page shows, decided without React. The canvas «Friends Page» draws three
 * tabs; the open one is the only page state kept in the address (`?tab=`). A missing or unknown tab
 * is «Мої друзі», and «Мої друзі» is written as the bare `/friends`, so the page has one address for it.
 */
export const FRIENDS_TABS = ['friends', 'requests', 'find'] as const

export type FriendsTab = (typeof FRIENDS_TABS)[number]

const DEFAULT_TAB: FriendsTab = 'friends'
const TAB_PARAM = 'tab'

/** `URLSearchParams` and Next's `ReadonlyURLSearchParams` alike. */
type QueryParameters = Pick<URLSearchParams, 'get'>

export function readFriendsTab(parameters: QueryParameters): FriendsTab {
  const value = parameters.get(TAB_PARAM)

  return FRIENDS_TABS.find((tab) => tab === value) ?? DEFAULT_TAB
}

/** The address of `tab`: every other parameter and the fragment stay as they are. */
export function friendsTabHref(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  tab: FriendsTab,
): string {
  const parameters = new URLSearchParams(location.search)

  if (tab === DEFAULT_TAB) parameters.delete(TAB_PARAM)
  else parameters.set(TAB_PARAM, tab)

  const query = parameters.toString()

  return `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`
}

/**
 * «Нещодавно додані» is the API's own order (`respondedAt` desc). The canvas's «Спершу з активними
 * позиками» needs loan data the friends list does not carry, so it is not offered.
 */
export type FriendsSort = 'recent' | 'name'

export const FRIENDS_SORT_LABELS: Readonly<Record<FriendsSort, string>> = {
  recent: 'Нещодавно додані',
  name: 'За ім’ям',
}

function fold(text: string): string {
  return text.trim().toLocaleLowerCase('uk-UA')
}

/** A search for «@olena» is a search for the nickname `olena`. */
function searchTermOf(query: string): string {
  return fold(query).replace(/^@/, '')
}

export function hasFriendsSearch(query: string): boolean {
  return searchTermOf(query) !== ''
}

/** The friends the search matches by name or nickname, in the chosen order. */
export function visibleFriends(
  friends: readonly Friend[],
  query: string,
  sort: FriendsSort,
): Friend[] {
  const term = searchTermOf(query)
  const matching =
    term === ''
      ? [...friends]
      : friends.filter(({ user }) =>
          `${fold(user.displayName)} ${fold(user.handle)}`.includes(term),
        )

  if (sort === 'name') {
    matching.sort((one, other) =>
      one.user.displayName.localeCompare(other.user.displayName, 'uk-UA'),
    )
  }

  return matching
}

const PLURAL = new Intl.PluralRules('uk-UA')

/** «1 друг», «3 друзі», «5 друзів», «21 друг». */
export function friendsCount(count: number): string {
  switch (PLURAL.select(count)) {
    case 'one':
      return `${count} друг`
    case 'few':
      return `${count} друзі`
    default:
      return `${count} друзів`
  }
}

/** The line under the toolbar: how much of the list the search left. */
export function friendsResultLabel(shown: number, total: number, query: string): string {
  return hasFriendsSearch(query)
    ? `Знайдено: ${friendsCount(shown)}`
    : `Показано ${shown} з ${friendsCount(total)}`
}

export type RequestOutcome = 'accepted' | 'declined'

/**
 * An incoming request answered on this page, kept until the page is left. `staleThrough` is the
 * newest friends load requested when the answer was recorded (`useFriends().latestRevision`): those
 * reads may have started before the answer, so their copy of the request says nothing new.
 */
export type AnsweredRequest = {
  request: FriendRequest
  outcome: RequestOutcome
  staleThrough: number
}

export type AnsweredRequests = Readonly<Record<string, AnsweredRequest>>

/** The incoming requests and the friends load that read them (`useFriends` ready state). */
export type IncomingSnapshot = { revision: number; incoming: readonly FriendRequest[] }

export type IncomingRow =
  | { kind: 'pending'; request: FriendRequest }
  | { kind: 'answered'; request: FriendRequest; outcome: RequestOutcome }

/**
 * The answers that still describe `snapshot`. The API reuses the friendship of a declined request
 * when it is sent again — the same id and `createdAt` — so only the read itself tells them apart: a
 * load requested after the answer that still lists the request lists a new one, and its answer is
 * over. Returns `answered` itself when nothing is over, so a state update with it is a no-op.
 */
export function currentAnswers(
  answered: AnsweredRequests,
  snapshot: IncomingSnapshot,
): AnsweredRequests {
  const listed = new Set(snapshot.incoming.map((request) => request.id))
  const over = Object.values(answered).filter(
    ({ request, staleThrough }) => snapshot.revision > staleThrough && listed.has(request.id),
  )

  if (over.length === 0) return answered

  const current = { ...answered }
  for (const { request } of over) delete current[request.id]

  return current
}

/**
 * The «Хочуть додати вас» rows. An answered request leaves `GET /friends/requests` on the next read,
 * but the canvas keeps its row with the outcome («Тепер ви друзі», «Запит відхилено»). So the rows
 * are the incoming requests and the answered ones together, newest first — the API's order — so a
 * row stays where it was when the list is read again.
 */
export function incomingRows(
  snapshot: IncomingSnapshot,
  answered: AnsweredRequests,
): IncomingRow[] {
  const current = currentAnswers(answered, snapshot)
  const pending: IncomingRow[] = snapshot.incoming
    .filter((request) => current[request.id] === undefined)
    .map((request) => ({ kind: 'pending', request }))
  const done: IncomingRow[] = Object.values(current).map(({ request, outcome }) => ({
    kind: 'answered',
    request,
    outcome,
  }))

  return [...pending, ...done].sort((one, other) =>
    other.request.createdAt.localeCompare(one.request.createdAt),
  )
}

/** The «Запити» tab count: incoming requests still waiting for an answer. */
export function pendingIncomingCount(
  snapshot: IncomingSnapshot,
  answered: AnsweredRequests,
): number {
  const current = currentAnswers(answered, snapshot)

  return snapshot.incoming.filter((request) => current[request.id] === undefined).length
}
