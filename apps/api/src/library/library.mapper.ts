import {
  EXCLUSIVE_LOAN_STATUS,
  OPEN_LOAN_STATUS,
  type BorrowedCopy,
  type Edition,
  type ExclusiveLoanStatus,
  type LibraryCounts,
  type LoanStatus,
  type OpenLoanStatus,
  type OwnCopy,
  type OwnerLoan,
  type ViewerLoan,
  type VisibleCopy,
  type Work,
  type WorkAuthor,
} from '@bookswap/shared'
import {
  byEditionOrder,
  toEdition,
  toWork,
  toWorkAuthors,
  type EditionRow,
  type WorkAuthorRow,
  type WorkRow,
} from '../catalog/catalog.mapper'
import type { ViewerRole } from '../access/visibility'
import { toPublicUser, type PublicUserRow } from '../users/user.mapper'
import type { CopyModel, LoanModel } from '../generated/prisma/models'

/**
 * Чисті проєкції та групування бібліотеки. Ні Prisma-клієнта, ні Nest — тому
 * §9 у частині «що саме віддається» перевіряється unit-тестом без PostgreSQL.
 *
 * Проєкцій три, і це не дублювання: власник, гість і той, у кого чужа книжка, —
 * різні ролі з різними правами. §9 вимагає, щоб приватне **не віддавалося з
 * API**, а не ховалося в UI, і єдиний надійний спосіб це гарантувати — щоб
 * приватного поля не існувало у відповідній функції взагалі. Одна проєкція з
 * прапорцями рано чи пізно віддала б нотатку не тому, кому слід.
 */

export type UserRow = PublicUserRow

/** Незавершений лоан на примірнику — рівно те, що потрібно для §6.5. */
export type CopyLoanRow = Pick<LoanModel, 'id' | 'status' | 'borrowerId' | 'dueAt'> & {
  borrower: UserRow
}

export type CopyRow = Pick<
  CopyModel,
  | 'id'
  | 'ownerId'
  | 'currentHolderId'
  | 'status'
  | 'visibility'
  | 'condition'
  | 'note'
  | 'acquiredAt'
  | 'createdAt'
> & {
  edition: EditionRow & { work: WorkRow & { authors: WorkAuthorRow[] } }
  owner: UserRow
  currentHolder: UserRow
  /** Лише незавершені (`OPEN_LOAN_STATUS`) — термінальні тут ні на що не впливають. */
  loans: CopyLoanRow[]
}

/**
 * Порядок «наскільки далеко зайшла домовленість». Потрібен як запобіжник: за
 * §5.1 у людини на одному примірнику незавершений лоан може бути лише один
 * (`REQUESTED` вимагає `AVAILABLE`, `APPROVED` робить `RESERVED`, другий
 * ексклюзивний блокує `one_active_loan_per_copy`), але мовчки взяти «перший
 * знайдений» означало б покластися на порядок рядків із бази.
 */
const OPEN_RANK: Readonly<Record<OpenLoanStatus, number>> = {
  REQUESTED: 1,
  APPROVED: 2,
  HANDED_OVER: 3,
}

/** Звуження без `as`: збіг шукається в самому кортежі зі `shared`. */
function asOpenStatus(status: LoanStatus): OpenLoanStatus | undefined {
  return OPEN_LOAN_STATUS.find((value) => value === status)
}

function asExclusiveStatus(status: LoanStatus): ExclusiveLoanStatus | undefined {
  return EXCLUSIVE_LOAN_STATUS.find((value) => value === status)
}

/**
 * §6.5: лоан **того, хто дивиться**, на цей примірник.
 *
 * Саме він, а не `Copy.status`, визначає стан кнопки «Попросити»: за §5.1 запит
 * примірника не змінює взагалі, тож після надісланого `REQUESTED` книжка
 * лишається `AVAILABLE`, і рішення за статусом дозволило б натиснути вдруге.
 */
export function viewerLoanOf(
  copy: { loans: Pick<CopyLoanRow, 'id' | 'status' | 'borrowerId'>[] },
  viewerId: string,
): ViewerLoan | null {
  let best: ViewerLoan | null = null

  for (const loan of copy.loans) {
    if (loan.borrowerId !== viewerId) continue

    const status = asOpenStatus(loan.status)

    if (status === undefined) continue
    if (best !== null && OPEN_RANK[status] <= OPEN_RANK[best.status]) continue

    best = { id: loan.id, status }
  }

  return best
}

/**
 * Ексклюзивний лоан на власному примірнику — той єдиний, що займає книжку.
 *
 * Гарантія одиничності — не припущення мапера, а частковий унікальний індекс
 * `one_active_loan_per_copy` (§5.3.1).
 */
export function ownerLoanOf(copy: CopyRow): OwnerLoan | null {
  for (const loan of copy.loans) {
    const status = asExclusiveStatus(loan.status)

    if (status === undefined) continue

    return { id: loan.id, status, counterpart: toPublicUser(loan.borrower) }
  }

  return null
}

/** §5.2: кількох одночасних `REQUESTED` на один примірник специфікація дозволяє. */
export function pendingRequestCountOf(copy: CopyRow): number {
  return copy.loans.filter((loan) => loan.status === 'REQUESTED').length
}

/**
 * §6.5: «Для `RESERVED` / `LENT_OUT` — орієнтовна дата повернення, якщо власник
 * її вказав».
 *
 * Береться з єдиного ексклюзивного лоану (§5.3.1) — і назовні йде **лише дата**.
 * Ані `loanId`, ані позичальника: гостю бібліотеки потрібна відповідь на питання
 * «коли книжка звільниться», а не «у кого вона». Останнє — це §6.6, і воно
 * приховується прапорцем `showHolderNames`, який до дати не застосовується: дата
 * є фактом про річ, а не про людину.
 *
 * Гейт на статус саме такий, як у §6.5: для `AVAILABLE` дата безглузда, а для
 * `UNAVAILABLE` (власник не дає або книжку втрачено) вона обіцяла б повернення,
 * якого ніхто не обіцяв.
 */
export function expectedReturnOf(
  copy: Pick<CopyRow, 'status'> & { loans: Pick<CopyLoanRow, 'status' | 'dueAt'>[] },
): string | null {
  if (copy.status !== 'RESERVED' && copy.status !== 'LENT_OUT') return null

  for (const loan of copy.loans) {
    if (asExclusiveStatus(loan.status) === undefined) continue

    return toIsoDate(loan.dueAt)
  }

  return null
}

/**
 * §6.5 і §9: чи може цей глядач попросити цей примірник просто зараз.
 *
 * Рахується на сервері, бо це авторизаційне питання. `/users/:id/library`
 * доступний не лише другові: §9 віддає `PUBLIC`-полицю будь-кому, а власнику —
 * його власну завжди. Малювати кнопку за `status === 'AVAILABLE'` означало б
 * показувати її тому, хто гарантовано отримає 403 `FORBIDDEN`, 400 `LOAN_SELF`
 * або 409 `LOAN_DUPLICATE_REQUEST`.
 *
 * Умови — рівно ті, що перевіряє `LoanService.request()`, і в тому самому
 * порядку. Це свідоме дублювання **предиката**, а не правил: правила лишаються
 * в §9-функціях і в сервісі, який ухвалює остаточне рішення. Тут — лише
 * передбачення відповіді, і e2e-тести звіряють його з реальним POST.
 */
export function canRequestCopy(
  copy: Pick<CopyRow, 'ownerId' | 'currentHolderId' | 'status'> & {
    loans: Pick<CopyLoanRow, 'id' | 'status' | 'borrowerId'>[]
  },
  role: ViewerRole,
  viewerId: string,
): boolean {
  if (role !== 'FRIEND') return false
  if (copy.ownerId === viewerId) return false
  if (copy.status !== 'AVAILABLE') return false
  if (!isHome(copy)) return false

  return viewerLoanOf(copy, viewerId) === null
}

export interface LibraryGroupOf<TCopy> {
  edition: Edition
  work: Work
  authors: WorkAuthor[]
  copies: TCopy[]
  counts: LibraryCounts
}

/** Інваріант §5.3.2 в термінах інтерфейсу: «вдома» = тримач і є власником. */
export function isHome(copy: Pick<CopyRow, 'ownerId' | 'currentHolderId'>): boolean {
  return copy.ownerId === copy.currentHolderId
}

/** Дата придбання без часу: «о котрій годині ви купили книжку» не означає нічого. */
function toIsoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

export function toOwnCopy(copy: CopyRow): OwnCopy {
  const home = isHome(copy)

  return {
    id: copy.id,
    status: copy.status,
    visibility: copy.visibility,
    condition: copy.condition,
    note: copy.note,
    acquiredAt: toIsoDate(copy.acquiredAt),
    createdAt: copy.createdAt.toISOString(),
    isHome: home,
    // Власник бачить імена завжди (§6.6) — його власний прапорець
    // `showHolderNames` керує тим, що бачать інші, а не він сам.
    holder: home ? null : toPublicUser(copy.currentHolder),
    activeLoan: ownerLoanOf(copy),
    pendingRequestCount: pendingRequestCountOf(copy),
  }
}

/**
 * `showHolderName` вирішує не ця функція, а `holderNamesVisibleTo` зі §9 — сюди
 * приїжджає вже готова відповідь. Інакше правило видимості імен існувало б у
 * двох місцях і розійшлося б.
 */
/** Хто дивиться на чужу полицю — усе, що потрібно проєкції §6.5. */
export interface Viewer {
  id: string
  /** §9: роль щодо власника полиці. Рахує її `AccessService.roleOf`. */
  role: ViewerRole
  /** §6.6: чи дозволено показувати імена тримачів. Рішення вже ухвалене. */
  showHolderNames: boolean
}

export function toVisibleCopy(copy: CopyRow, viewer: Viewer): VisibleCopy {
  const home = isHome(copy)

  return {
    id: copy.id,
    status: copy.status,
    condition: copy.condition,
    isHome: home,
    holder: home || !viewer.showHolderNames ? null : toPublicUser(copy.currentHolder),
    // Тільки свій лоан. Чиї ще запити висять на цьому примірнику — не справа
    // гостя бібліотеки: `pendingRequestCount` існує лише у власника.
    myActiveLoan: viewerLoanOf(copy, viewer.id),
    canRequest: canRequestCopy(copy, viewer.role, viewer.id),
    expectedReturnAt: expectedReturnOf(copy),
  }
}

export function toBorrowedCopy(copy: CopyRow, viewerId: string): BorrowedCopy {
  return {
    id: copy.id,
    status: copy.status,
    condition: copy.condition,
    owner: toPublicUser(copy.owner),
    // Лоан, яким книжка опинилася тут: сторінка «чужі в мене» веде саме на нього.
    activeLoan: viewerLoanOf(copy, viewerId),
  }
}

/**
 * §6.4: «Шантарам ×3 · 2 вдома, 1 у Марка».
 *
 * Групування — подання, а не модель: окремі `Copy` лишаються поштучно в
 * `copies`, бо кількість примірників — це `COUNT` рядків, а не поле `quantity`
 * (§3). Проєкція елемента передається зовні, тож та сама логіка групування
 * обслуговує всі три ролі, не знаючи про жодну з них.
 */
export function groupByEdition<TCopy>(
  copies: CopyRow[],
  project: (copy: CopyRow) => TCopy,
): LibraryGroupOf<TCopy>[] {
  const groups = new Map<string, CopyRow[]>()

  for (const copy of copies) {
    const existing = groups.get(copy.edition.id)

    if (existing === undefined) groups.set(copy.edition.id, [copy])
    else existing.push(copy)
  }

  return [...groups.values()]
    .flatMap((rows) => {
      const [first] = rows

      if (first === undefined) return []

      const ordered = [...rows].sort(
        (one, other) =>
          one.createdAt.getTime() - other.createdAt.getTime() || one.id.localeCompare(other.id),
      )
      const home = ordered.filter(isHome).length

      return [
        {
          edition: toEdition(first.edition, first.edition.work),
          work: toWork(first.edition.work),
          authors: toWorkAuthors(first.edition.work.authors),
          copies: ordered.map(project),
          counts: { total: ordered.length, home, out: ordered.length - home },
        },
      ]
    })
    .sort(
      (one, other) =>
        one.work.title.localeCompare(other.work.title, 'uk') ||
        byEditionOrder(one.edition, other.edition),
    )
}
