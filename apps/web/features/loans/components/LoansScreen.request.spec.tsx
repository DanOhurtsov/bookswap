/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { SessionState } from '@/app/lib/use-session'
import { ToastProvider } from '@/components/ui/toast'
import { watchHistory } from '@/features/library/own-library/own-library.test-helpers'
import { loanOf } from '../loans.test-helpers'
import { addDays, localDay, shortDay } from '../model/loan-term'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: jest.requireActual<
    typeof import('@/features/library/own-library/own-library.test-helpers')
  >('@/features/library/own-library/own-library.test-helpers').useAddressSearchParams,
}))

const SIGNED_IN: Extract<SessionState, { status: 'authenticated' }> = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    handle: 'reader',
    city: null,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    friendsOfFriendsAccess: false,
    loanRequestsPaused: false,
    defaultLoanTermDays: null,
    ownerDueReminders: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: SIGNED_IN }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const TODAY = localDay(new Date())
/** Олесь asks for my «Дюна» for three weeks. */
const ASKED = addDays(TODAY, 21)
const REQUEST: Loan = loanOf({
  id: 'loan-7',
  side: 'lent',
  title: 'Дюна',
  authors: ['Френк Герберт'],
  year: 2020,
  status: 'REQUESTED',
  respondedAt: null,
  handedAt: null,
  dueAt: ASKED,
  message: 'Хочу перечитати перед клубом',
  copy: { id: 'copy-loan-7', status: 'AVAILABLE', condition: 'GOOD', isArchived: false },
})

const patches = () =>
  apiRequest.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method)

/**
 * `GET /loans/:id` answers `current()`; a `PATCH` goes to `onPatch` and, once it is through, the
 * loan the server would now send is `after`.
 */
function serve(
  first: Loan,
  { onPatch, after }: { onPatch?: () => Promise<unknown>; after?: Loan } = {},
) {
  let current = first

  apiRequest.mockImplementation(async (_path: string, init?: { method?: string }) => {
    if (init?.method !== 'PATCH') return { loan: current }
    const answer = await (onPatch ?? (() => Promise.resolve({})))()
    if (after !== undefined) current = after

    return answer
  })

  return {
    change: (next: Loan) => {
      current = next
    },
  }
}

function open(loan: Loan, options?: Parameters<typeof serve>[1]) {
  window.history.replaceState(null, '', '/loans?role=owner&loanId=loan-7')
  const server = serve(loan, options)
  render(<LoansScreen />, { wrapper: ToastProvider })

  return server
}

const summary = async () => screen.findByRole('group', { name: 'Повернути до' })
const chosen = async () => (await summary()).querySelector('.loan-term__due')?.textContent
const preset = (name: RegExp) => screen.getByRole('radio', { name })
const dialog = () => screen.getByRole('alertdialog')

let unwatchHistory: () => void = () => undefined

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  apiRequest.mockReset()
  unwatchHistory = watchHistory()
})

afterEach(() => {
  unwatchHistory()
})

describe('запит до власника: що показано', () => {
  it('хто просить, повідомлення й книжка — лише з даних позики, без вигаданої статистики', async () => {
    open(REQUEST)

    expect(await screen.findByRole('heading', { name: 'Запит на книжку' })).toBeVisible()
    const who = screen.getByRole('region', { name: 'Хто просить' })

    expect(within(who).getByRole('link', { name: 'Олесь' })).toHaveAttribute('href', '/u/oles')
    expect(within(who).getByText('@oles')).toBeVisible()
    expect(within(who).getByText('«Хочу перечитати перед клубом»')).toBeVisible()
    expect(who).not.toHaveTextContent(/вчасно|спільн|позики з вами/)

    const book = screen.getByRole('region', { name: 'Ваша книжка' })

    expect(within(book).getByRole('link', { name: 'Дюна' })).toHaveAttribute(
      'href',
      '/works/work-loan-7',
    )
    expect(book).toHaveTextContent('Френк Герберт · Мʼяка обкладинка · 2020')
    expect(book).toHaveTextContent('Вдома, вільна')
    expect(book).not.toHaveTextContent(/Ще \d+ запит/)
  })

  it('дата позичальника обрана й позначена «за запитом»; без обіцянок про строк від передачі', async () => {
    open(REQUEST)

    expect(await chosen()).toBe(shortDay(ASKED))
    expect(preset(/^3 тижні/)).toHaveAttribute('aria-checked', 'true')
    expect(preset(/^3 тижні/)).toHaveTextContent('за запитом')
    expect(screen.getByRole('group', { name: 'Термін позики' })).not.toHaveTextContent(/передач/)
  })
})

describe('запит до власника: строк і повідомлення', () => {
  it('пресет змінює дату на сьогодні + N днів, «Повернути як у запиті» повертає дату позичальника', async () => {
    const user = userEvent.setup()

    open(REQUEST)
    await user.click(await screen.findByRole('radio', { name: /^Тиждень/ }))

    expect(await chosen()).toBe(shortDay(addDays(TODAY, 7)))
    expect(screen.getByText('Ви змінили дату')).toBeVisible()
    expect(screen.getByText(`У запиті — до ${shortDay(ASKED)}.`)).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Повернути як у запиті' }))

    expect(await chosen()).toBe(shortDay(ASKED))
    expect(screen.queryByText('Ви змінили дату')).not.toBeInTheDocument()
  })

  it('календар з клавіатури: стрілка переводить фокус на наступний день, Enter обирає його', async () => {
    const user = userEvent.setup()

    open(REQUEST)
    await summary()

    const selected = screen.getByRole('button', { name: `${shortDay(ASKED)}, обрана дата` })

    selected.focus()
    await user.keyboard('{ArrowRight}')

    const next = addDays(ASKED, 1)

    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('data-day', next)
    })
    await user.keyboard('{Enter}')

    expect(await chosen()).toBe(shortDay(next))
    expect(screen.getByRole('radio', { name: /^Своя дата/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('дата в запиті є — «Без дати» не пропонується: погодити можна лише з датою', async () => {
    open(REQUEST)

    await screen.findByRole('radiogroup', { name: 'Тривалість позики' })
    expect(screen.queryByRole('radio', { name: /^Без дати/ })).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: `Погодити до ${shortDay(ASKED)}` }),
    ).toBeInTheDocument()
  })

  it('запит без дати: «Без дати» перший і обраний; обраний пресет міняє кнопку, «Без дати» повертає', async () => {
    const user = userEvent.setup()

    open({ ...REQUEST, dueAt: null })

    const none = await screen.findByRole('radio', { name: /^Без дати/ })

    expect(screen.getAllByRole('radio')[0]).toBe(none)
    expect(none).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Погодити без терміну' })).toBeEnabled()

    await user.click(screen.getByRole('radio', { name: /^Тиждень/ }))
    expect(
      screen.getByRole('button', { name: `Погодити до ${shortDay(addDays(TODAY, 7))}` }),
    ).toBeInTheDocument()

    await user.click(none)
    expect(screen.getByRole('button', { name: 'Погодити без терміну' })).toBeInTheDocument()
  })

  it('лічильник відповідає контракту: 1000 символів, не 300', async () => {
    const user = userEvent.setup()

    open(REQUEST)

    const note = await screen.findByLabelText(/Повідомлення до погодження/)

    expect(note).toHaveAttribute('maxLength', '1000')
    expect(screen.getByText('0/1000')).toBeVisible()
    await user.type(note, 'Біля метро')
    expect(screen.getByText('10/1000')).toBeVisible()
  })
})

describe('запит до власника: погодження', () => {
  it('надсилає дату й відповідь; «Запит погоджено» — лише коли перечитана позика APPROVED', async () => {
    const user = userEvent.setup()
    let accept: (value: unknown) => void = () => undefined

    open(REQUEST, {
      onPatch: () => new Promise((resolve) => (accept = resolve)),
      after: { ...REQUEST, status: 'APPROVED', respondedAt: '2026-10-02T09:00:00.000Z' },
    })
    await user.type(await screen.findByLabelText(/Повідомлення до погодження/), 'У суботу')
    await user.click(screen.getByRole('button', { name: `Погодити до ${shortDay(ASKED)}` }))

    expect(screen.getByRole('button', { name: 'Погоджую…' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('Запит погоджено', { selector: 'h4' })).not.toBeInTheDocument()
    expect(patches()).toEqual([
      [
        '/loans/loan-7',
        { method: 'PATCH', body: { action: 'approve', dueAt: ASKED, note: 'У суботу' } },
      ],
    ])

    accept({})

    const outcome = await screen.findByRole('heading', { name: 'Запит погоджено' })

    expect(outcome.closest('[role="status"]')).toHaveTextContent(`Повернути до ${shortDay(ASKED)}.`)
    await waitFor(() => {
      expect(outcome).toHaveFocus()
    })

    await user.click(screen.getByRole('button', { name: 'Відкрити позику' }))

    expect(await screen.findByRole('heading', { name: 'Домовтеся про передачу' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Дюна' })).toBeVisible()
  })

  it('повторне натискання поки запит іде не шле другий PATCH', async () => {
    const user = userEvent.setup()

    open(REQUEST, { onPatch: () => new Promise(() => undefined) })

    const approve = await screen.findByRole('button', { name: `Погодити до ${shortDay(ASKED)}` })

    await user.click(approve)
    await user.click(screen.getByRole('button', { name: 'Погоджую…' }))
    await user.click(screen.getByRole('button', { name: 'Відмовити' }))

    expect(patches()).toHaveLength(1)
  })

  it('помилка зʼєднання: пояснення, обрана дата й текст лишаються, повтор шле те саме', async () => {
    const user = userEvent.setup()
    let fail = true

    open(REQUEST, {
      onPatch: () =>
        fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({}),
      after: { ...REQUEST, status: 'APPROVED' },
    })
    await user.click(await screen.findByRole('radio', { name: /^2 тижні/ }))
    await user.type(screen.getByLabelText(/Повідомлення до погодження/), 'Біля метро')

    const due = addDays(TODAY, 14)

    await user.click(screen.getByRole('button', { name: `Погодити до ${shortDay(due)}` }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не вдалося відповісти на запит. Перевірте зʼєднання і спробуйте ще раз. Вибрана дата й повідомлення збережені.',
    )
    expect(await chosen()).toBe(shortDay(due))
    expect(screen.getByLabelText(/Повідомлення до погодження/)).toHaveValue('Біля метро')
    expect(screen.queryByText('Запит погоджено')).not.toBeInTheDocument()

    fail = false
    await user.click(screen.getByRole('button', { name: `Погодити до ${shortDay(due)}` }))

    expect(await screen.findByRole('heading', { name: 'Запит погоджено' })).toBeVisible()
    expect(patches().map(([, init]) => (init as { body: unknown }).body)).toEqual([
      { action: 'approve', dueAt: due, note: 'Біля метро' },
      { action: 'approve', dueAt: due, note: 'Біля метро' },
    ])
  })

  it('позичальник уже скасував: конфлікт перечитує позику й каже «Запит відкликано»', async () => {
    const user = userEvent.setup()
    const conflict = new ApiRequestError(409, {
      code: 'LOAN_INVALID_TRANSITION',
      message: 'Цей запит уже не чекає відповіді',
    })
    const server = open(REQUEST, { onPatch: () => Promise.reject(conflict) })

    await screen.findByRole('heading', { name: 'Запит на книжку' })
    server.change({ ...REQUEST, status: 'CANCELLED' })
    await user.click(screen.getByRole('button', { name: `Погодити до ${shortDay(ASKED)}` }))

    const outcome = await screen.findByRole('heading', { name: 'Запит відкликано' })

    expect(outcome.closest('[role="status"]')).toHaveTextContent(
      'Позичальник скасував запит, поки ви відповідали. Нічого робити не потрібно.',
    )
    expect(screen.queryByRole('button', { name: 'Відкрити позику' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'До позичань' })).toHaveAttribute(
      'href',
      '/loans?role=owner',
    )
  })
})

describe('запит до власника: відмова', () => {
  it('спершу питає; «Не відмовляти» нічого не шле, «Відмовити» — reject і «Запит відхилено»', async () => {
    const user = userEvent.setup()

    open(REQUEST, {
      after: { ...REQUEST, status: 'REJECTED', respondedAt: '2026-10-02T09:00:00.000Z' },
    })
    await user.click(await screen.findByRole('button', { name: 'Відмовити' }))

    expect(dialog()).toHaveTextContent('Відмовити в запиті?')
    await user.click(within(dialog()).getByRole('button', { name: 'Не відмовляти' }))
    expect(patches()).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Відмовити' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Відмовити' }))
    await user.click(within(dialog()).getByRole('button', { name: 'Відмовити' }))

    expect(await screen.findByRole('heading', { name: 'Запит відхилено' })).toBeVisible()
    expect(patches()).toEqual([['/loans/loan-7', { method: 'PATCH', body: { action: 'reject' } }]])
    expect(screen.queryByRole('button', { name: 'Відкрити позику' })).not.toBeInTheDocument()
  })
})

describe('запит до власника: хто його бачить', () => {
  it('позичальник свого запиту бачить звичайну сторінку позики, не форму власника', async () => {
    window.history.replaceState(null, '', '/loans?loanId=loan-7')
    serve(
      loanOf({
        id: 'loan-7',
        side: 'borrowed',
        status: 'REQUESTED',
        respondedAt: null,
        handedAt: null,
      }),
    )
    render(<LoansScreen />, { wrapper: ToastProvider })

    expect(await screen.findByRole('heading', { name: 'Запит надіслано' })).toBeVisible()
    expect(screen.queryByRole('group', { name: 'Термін позики' })).not.toBeInTheDocument()
  })

  it('власник, що відкрив уже закритий запит, бачить сторінку позики, а не «результат відповіді»', async () => {
    window.history.replaceState(null, '', '/loans?loanId=loan-7')
    serve({ ...REQUEST, status: 'CANCELLED' })
    render(<LoansScreen />, { wrapper: ToastProvider })

    expect(await screen.findByRole('heading', { name: 'Позичальник скасував запит' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Запит відкликано' })).not.toBeInTheDocument()
  })
})
