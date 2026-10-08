/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GuestLoan, GuestLoanConfirmation } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { GuestLoansScreen } from './GuestLoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let parameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useSearchParams: () => parameters,
}))

const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()
const DAY = 24 * 60 * 60 * 1000

const BASE_EDITION = {
  id: 'ed-1',
  workId: 'work-1',
  translationId: null,
  textKind: 'ORIGINAL',
  publisher: null,
  year: null,
  isbn13: null,
  pageCount: null,
  coverUrl: null,
  format: 'PAPERBACK',
  lang: 'uk',
  translator: null,
  revision: 1,
} as const

const BASE_WORK = {
  id: 'work-1',
  title: 'Тестова книга',
  origLang: 'uk',
  firstPubYear: null,
  description: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
} as const

const CONTACT = {
  id: 'contact-1',
  alias: 'Мій Псевдонім',
  guestNickname: null,
  guestEmail: null,
  guestEmailVerifiedAt: null,
}

function confirmation(overrides: Partial<GuestLoanConfirmation> = {}): GuestLoanConfirmation {
  return {
    id: 'conf-1',
    status: 'OPEN',
    evidence: 'AWAITING_GUEST',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    loan: {
      id: 'loan-1',
      status: 'PENDING_CONFIRMATION',
      isOverdue: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      handedAt: '2026-01-01T00:00:00.000Z',
      returnedAt: null,
      dueAt: null,
    },
    copy: { id: 'copy-1', status: 'RESERVED', condition: 'GOOD', isArchived: false },
    edition: { ...BASE_EDITION },
    work: { ...BASE_WORK },
    authors: [],
    contact: { ...CONTACT },
    link: null,
    ...overrides,
  }
}

const LOAN: GuestLoan = {
  id: 'loan-9',
  status: 'HANDED_OVER',
  evidence: 'OWNER_STATEMENT',
  isOverdue: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  handedAt: '2026-01-01T00:00:00.000Z',
  returnedAt: null,
  dueAt: null,
  copy: { id: 'copy-9', status: 'LENT_OUT', condition: 'GOOD', isArchived: false },
  edition: { ...BASE_EDITION },
  work: { ...BASE_WORK, id: 'work-9', title: 'Стара ручна позика' },
  authors: [],
  contact: { id: 'contact-1', alias: 'Мій Псевдонім' },
  recovery: null,
  lossClosure: null,
}

interface Server {
  confirmations: GuestLoanConfirmation[]
  loans: GuestLoan[]
  /** Відповіді на POST /link по черзі. */
  linkResponses?: (() => Promise<unknown>)[]
  patch?: (body: unknown) => Promise<unknown>
}

/** Мутований «сервер»: після дії власника наступне GET віддає оновлений стан. */
function mockServer(server: Server) {
  let linkCall = 0

  mockApiRequest.mockImplementation(
    (path: string, options?: { method?: string; body?: unknown }) => {
      const method = options?.method ?? 'GET'

      if (path === '/guest-loan-confirmations' && method === 'GET') {
        return Promise.resolve({ confirmations: server.confirmations })
      }

      if (path === '/loans/guest' && method === 'GET')
        return Promise.resolve({ loans: server.loans })

      if (/^\/guest-loan-confirmations\/[^/]+\/link$/.test(path) && method === 'POST') {
        const respond = server.linkResponses?.[linkCall]

        linkCall += 1

        return respond === undefined ? Promise.reject(new Error('no link response')) : respond()
      }

      const single = /^\/guest-loan-confirmations\/([^/]+)$/.exec(path)

      if (single !== null && method === 'GET') {
        const found = server.confirmations.find((item) => item.id === single[1])

        return found === undefined
          ? Promise.reject(new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Не знайдено' }))
          : Promise.resolve({ confirmation: found })
      }

      if (single !== null && method === 'PATCH') {
        return (server.patch ?? (() => Promise.reject(new Error('no patch'))))(options?.body)
      }

      return Promise.reject(new Error(`unexpected ${method} ${path}`))
    },
  )
}

const callsTo = (predicate: (path: string, method: string) => boolean) =>
  mockApiRequest.mock.calls.filter(([path, options]: [string, { method?: string }?]) =>
    predicate(path, options?.method ?? 'GET'),
  )

const linkCalls = () => callsTo((path, method) => path.endsWith('/link') && method === 'POST')

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

beforeEach(() => {
  mockApiRequest.mockReset()
  parameters = new URLSearchParams()
})

/** Картка запиту за назвою статусу (кілька карток одночасно). */
const card = (status: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(`[data-confirmation-status="${status}"]`)

  if (element === null) throw new Error(`Немає картки зі статусом ${status}`)

  return element
}

describe('запити підтвердження в owner UI: стани й джерело факту (GC1, GC4, GC6)', () => {
  it('показує всі п’ять станів із підписами джерела окремо від статусу', async () => {
    mockServer({
      loans: [],
      confirmations: [
        confirmation({ id: 'c-open' }),
        confirmation({ id: 'c-denied', status: 'DENIED', evidence: 'GUEST_DENIED' }),
        confirmation({
          id: 'c-received',
          status: 'RECEIVED',
          evidence: 'GUEST_CONFIRMED',
          resolvedAt: '2026-02-01T10:00:00.000Z',
        }),
        confirmation({ id: 'c-cancelled', status: 'CANCELLED', evidence: null }),
        confirmation({ id: 'c-owner', status: 'OWNER_RECORDED', evidence: 'OWNER_STATEMENT' }),
      ],
    })
    render(<GuestLoansScreen />)

    await screen.findAllByText(/Очікує відповіді гостя/)

    expect(within(card('OPEN')).getByText('очікуємо відповідь гостя')).toBeInTheDocument()
    expect(within(card('DENIED')).getByText('гість заперечує')).toBeInTheDocument()
    expect(within(card('RECEIVED')).getByText('підтверджено гостем')).toBeInTheDocument()
    expect(within(card('OWNER_RECORDED')).getByText('зі слів власника')).toBeInTheDocument()
    expect(
      within(card('CANCELLED')).getByText(/передачу скасовано, факту немає/),
    ).toBeInTheDocument()

    for (const label of [
      'Очікує відповіді гостя',
      'Гість заперечує отримання',
      'Гість підтвердив отримання',
      'Передачу скасовано',
      'Залишено зі слів власника',
    ]) {
      expect(screen.getAllByText(new RegExp(label)).length).toBeGreaterThan(0)
    }
  })

  it('OPEN не називає отримання підтвердженим: «ще не підтверджене», примірник недоступний, мовчання не підтверджує', async () => {
    mockServer({ loans: [], confirmations: [confirmation()] })
    render(<GuestLoansScreen />)

    const open = await screen.findByText(/ще не підтверджене/)

    expect(open).toBeInTheDocument()
    expect(screen.getByText(/Мовчання його не підтверджує/)).toBeInTheDocument()
    expect(within(card('OPEN')).queryByText('підтверджено гостем')).not.toBeInTheDocument()
  })

  it('ручні позики 10f.3 лишаються «зі слів власника»; підтверджена гостем — окремо, без заднього перезапису', async () => {
    mockServer({
      confirmations: [],
      loans: [
        LOAN,
        {
          ...LOAN,
          id: 'loan-10',
          evidence: 'GUEST_CONFIRMED',
          work: { ...LOAN.work, id: 'w10', title: 'Підтверджена' },
        },
      ],
    })
    render(<GuestLoansScreen />)

    await screen.findByText('Стара ручна позика')

    const manual = screen.getByText('Стара ручна позика').closest('li')
    const confirmed = screen.getByText('Підтверджена').closest('li')

    expect(manual).not.toBeNull()
    expect(within(manual as HTMLElement).getByText('зі слів власника')).toBeInTheDocument()
    expect(within(manual as HTMLElement).queryByText('підтверджено гостем')).not.toBeInTheDocument()
    expect(within(confirmed as HTMLElement).getByText('підтверджено гостем')).toBeInTheDocument()
    // Дії ручної позики 10f.3 працездатні, як і раніше.
    expect(
      within(manual as HTMLElement).getByRole('button', { name: 'Повернуто' }),
    ).toBeInTheDocument()
  })

  it('?confirmationId=: один запит через GET /guest-loan-confirmations/:id (посилання зі сповіщення)', async () => {
    parameters = new URLSearchParams('confirmationId=conf-7')
    mockServer({ loans: [], confirmations: [confirmation({ id: 'conf-7' })] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(screen.getByText('Показати всі')).toBeInTheDocument()
    expect(callsTo((path) => path === '/guest-loan-confirmations/conf-7')).toHaveLength(1)
    // Список позик не тягнеться в цьому режимі.
    expect(callsTo((path) => path === '/loans/guest')).toHaveLength(0)
  })

  it('чужий/невідомий запит: 404 → пояснення без даних', async () => {
    parameters = new URLSearchParams('confirmationId=nope')
    mockServer({ loans: [], confirmations: [] })
    render(<GuestLoansScreen />)

    expect(
      await screen.findByText(/цього запиту більше немає або він вам не належить/),
    ).toBeInTheDocument()
  })

  it('GC10: синтетичне попередження на екрані', async () => {
    mockServer({ loans: [], confirmations: [] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
  })
})

describe('видача посилання: COPY і тестовий EMAIL (GC1, GC7, GC10, GC11, GC13)', () => {
  const URL_1 = 'http://localhost:3000/guest-loan-confirmation#token-one'
  const URL_2 = 'http://localhost:3000/guest-loan-confirmation#token-two'
  const issued = (url: string | null, delivery: 'COPY' | 'EMAIL') => () =>
    Promise.resolve({ confirmation: confirmation(), delivery, url })

  it('стан посилання: не видавалося / діє до … / строк минув (запит не закривається автоматично)', async () => {
    mockServer({
      loans: [],
      confirmations: [
        confirmation({ id: 'none', link: null }),
        confirmation({
          id: 'live',
          link: { issuedAt: iso(-DAY), expiresAt: iso(6 * DAY), isExpired: false },
        }),
        confirmation({
          id: 'gone',
          link: { issuedAt: iso(-8 * DAY), expiresAt: iso(-DAY), isExpired: true },
        }),
      ],
    })
    render(<GuestLoansScreen />)

    await screen.findAllByTestId('link-state')

    const states = screen.getAllByTestId('link-state').map((element) => element.textContent)

    expect(states[0]).toMatch(/Посилання ще не видавалося/)
    expect(states[1]).toMatch(/Посилання діє до/)
    expect(states[2]).toMatch(/Строк дії посилання минув/)
    expect(states[2]).toMatch(/Запит НЕ закрито/)
    expect(states[2]).toMatch(/примірник лишається недоступним/)
    // Сплив нічого не закрив: усі три картки лишаються OPEN, дії власника доступні, нових запитів не було.
    expect(document.querySelectorAll('[data-confirmation-status="OPEN"]')).toHaveLength(3)
    expect(screen.getAllByRole('button', { name: 'Скасувати помилкову передачу' })).toHaveLength(3)
    expect(
      mockApiRequest.mock.calls.every(
        ([, options]: [string, { method?: string }?]) => (options?.method ?? 'GET') === 'GET',
      ),
    ).toBe(true)
  })

  it('пояснює: 7 днів від видачі, повторна видача гасить старе посилання', async () => {
    mockServer({ loans: [], confirmations: [confirmation()] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText(/Посилання діє 7 днів від видачі/)).toBeInTheDocument()
    expect(screen.getByText(/Повторна видача гасить попереднє посилання/)).toBeInTheDocument()
  })

  it('COPY: POST /link {delivery: COPY}, посилання показується в UI', async () => {
    mockServer({
      loans: [],
      confirmations: [confirmation()],
      linkResponses: [issued(URL_1, 'COPY')],
    })
    render(<GuestLoansScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Видати посилання (скопіювати)' }),
    )

    expect(await screen.findByDisplayValue(URL_1)).toHaveAttribute('readonly')
    expect(linkCalls()).toHaveLength(1)
    expect(linkCalls()[0]).toEqual([
      '/guest-loan-confirmations/conf-1/link',
      expect.objectContaining({ method: 'POST', body: { delivery: 'COPY' } }),
    ])
    expect(screen.getByText(/показується лише зараз/)).toBeInTheDocument()
  })

  it('повторна видача: нове посилання ЗАМІНЮЄ показане (старе погашене), кнопка називає це «новим»', async () => {
    const server: Server = { loans: [], confirmations: [confirmation()] }
    const live = () =>
      confirmation({ link: { issuedAt: iso(0), expiresAt: iso(7 * DAY), isExpired: false } })

    server.linkResponses = [
      () => {
        // Сервер після першої видачі вже має чинне посилання — наступне читання це віддає.
        server.confirmations = [live()]

        return issued(URL_1, 'COPY')()
      },
      issued(URL_2, 'COPY'),
    ]
    mockServer(server)
    render(<GuestLoansScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Видати посилання (скопіювати)' }),
    )
    await screen.findByDisplayValue(URL_1)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Видати нове посилання (скопіювати)' }),
    )

    expect(await screen.findByDisplayValue(URL_2)).toBeInTheDocument()
    expect(screen.queryByDisplayValue(URL_1)).not.toBeInTheDocument()
    expect(linkCalls()).toHaveLength(2)
  })

  it('EMAIL: адреса доставки A іде лише в POST /link, після відправки не показується й не зберігається як email гостя', async () => {
    const A = 'delivery-a@guest.invalid'

    mockServer({
      loans: [],
      confirmations: [confirmation()],
      linkResponses: [issued(null, 'EMAIL')],
    })
    render(<GuestLoansScreen />)

    await userEvent.type(await screen.findByLabelText('Тестовий лист: адреса доставки'), A)
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати посилання листом' }))

    await screen.findByText(/тестовий поштовий транспорт/)

    expect(linkCalls()[0]).toEqual([
      '/guest-loan-confirmations/conf-1/link',
      expect.objectContaining({ method: 'POST', body: { delivery: 'EMAIL', email: A } }),
    ])
    // Чесно: лист нікуди назовні не доставляється, реальна людина його не отримала.
    expect(
      screen.getByText(/Він нічого не доставляє назовні: жодна реальна людина листа не отримала/),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(
      /лист(а)? (успішно )?(доставлено|отримано|надіслано гостю)/i,
    )
    // A не повертається у видимому тексті й очищене з поля; окремим email гостя не стає.
    expect(document.body.textContent).not.toContain(A)
    expect(screen.getByLabelText('Тестовий лист: адреса доставки')).toHaveValue('')
    expect(within(card('OPEN')).queryByTestId('guest-private-details')).not.toBeInTheDocument()
    // Пояснення A ≠ B.
    expect(screen.getByText(/не вважається email гостя/)).toBeInTheDocument()
  })

  it('EMAIL: адреса не з домену guest.invalid відхиляється на клієнті (D2) — запит не йде', async () => {
    mockServer({ loans: [], confirmations: [confirmation()] })
    render(<GuestLoansScreen />)

    await userEvent.type(
      await screen.findByLabelText('Тестовий лист: адреса доставки'),
      'real@example.com',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати посилання листом' }))

    expect(
      await screen.findByText(/Лише синтетичні адреси домену guest\.invalid/),
    ).toBeInTheDocument()
    expect(linkCalls()).toHaveLength(0)
  })

  it('збій видачі (502 GUEST_LINK_EMAIL_FAILED): помилка показана, транспорт не оголошений успішним', async () => {
    mockServer({
      loans: [],
      confirmations: [confirmation()],
      linkResponses: [
        () =>
          Promise.reject(
            new ApiRequestError(502, {
              code: 'GUEST_LINK_EMAIL_FAILED',
              message: 'Лист не надіслано',
            }),
          ),
      ],
    })
    render(<GuestLoansScreen />)

    await userEvent.type(
      await screen.findByLabelText('Тестовий лист: адреса доставки'),
      'x@guest.invalid',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати посилання листом' }))

    expect(await screen.findByText('Лист не надіслано')).toBeInTheDocument()
    expect(screen.queryByText(/тестовий поштовий транспорт/)).not.toBeInTheDocument()
  })

  it('видача посилання доступна лише для OPEN: для DENIED/RECEIVED/CANCELLED/OWNER_RECORDED панелі посилання немає', async () => {
    mockServer({
      loans: [],
      confirmations: [
        confirmation({ id: 'd', status: 'DENIED', evidence: 'GUEST_DENIED' }),
        confirmation({ id: 'r', status: 'RECEIVED', evidence: 'GUEST_CONFIRMED' }),
        confirmation({ id: 'c', status: 'CANCELLED', evidence: null }),
        confirmation({ id: 'o', status: 'OWNER_RECORDED', evidence: 'OWNER_STATEMENT' }),
      ],
    })
    render(<GuestLoansScreen />)

    await screen.findByText(/Гість заперечує отримання/)

    expect(screen.queryByRole('button', { name: /Видати/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Тестовий лист: адреса доставки')).not.toBeInTheDocument()
    expect(screen.getByText(/Нове посилання для цієї відповіді не видається/)).toBeInTheDocument()
  })
})

describe('DENIED: розбіжність і дії власника (GC5)', () => {
  const denied = () => confirmation({ status: 'DENIED', evidence: 'GUEST_DENIED' })

  it('показує розбіжність, а не повернення; примірник сам не звільняється; обидві дії власника доступні', async () => {
    mockServer({ loans: [], confirmations: [denied()] })
    render(<GuestLoansScreen />)

    expect(await screen.findByRole('alert')).toHaveTextContent(/Це розбіжність, а не повернення/)
    expect(screen.getByText(/сам не звільняється й лишається недоступним/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скасувати помилкову передачу' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Залишити зі слів власника' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/примірник (знову )?(став )?доступн/)
    // Нічого не сталося без дії власника: лише GET.
    expect(callsTo((_, method) => method !== 'GET')).toHaveLength(0)
  })

  it('скасування — лише після явного підтвердження «книжка в мене»: PATCH з bookIsWithOwner: true', async () => {
    mockServer({
      loans: [],
      confirmations: [denied()],
      patch: () => Promise.resolve({ confirmation: denied() }),
    })
    render(<GuestLoansScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Скасувати помилкову передачу' }),
    )

    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByText(/лише якщо книжка фізично в вас/)).toBeInTheDocument()
    // Відмова від підтвердження не надсилає нічого.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))
    expect(callsTo((_, method) => method === 'PATCH')).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: 'Скасувати помилкову передачу' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Так, книжка в мене — скасувати передачу',
      }),
    )

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/guest-loan-confirmations/conf-1',
        expect.objectContaining({
          method: 'PATCH',
          body: { action: 'cancel_handover', bookIsWithOwner: true },
        }),
      )
    })
  })

  it('«Залишити зі слів власника»: PATCH record_owner_statement; попереджає, що це не підтвердження гостя', async () => {
    mockServer({
      loans: [],
      confirmations: [denied()],
      patch: () => Promise.resolve({ confirmation: denied() }),
    })
    render(<GuestLoansScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Залишити зі слів власника' }))

    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByText(/НЕ підтвердження гостя/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Залишити зі слів власника' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/guest-loan-confirmations/conf-1',
        expect.objectContaining({ method: 'PATCH', body: { action: 'record_owner_statement' } }),
      )
    })
  })

  it('OWNER_RECORDED не маскується під відповідь гостя: джерело «зі слів власника», прямо «не відповідь гостя»', async () => {
    mockServer({
      loans: [],
      confirmations: [confirmation({ status: 'OWNER_RECORDED', evidence: 'OWNER_STATEMENT' })],
    })
    render(<GuestLoansScreen />)

    await screen.findAllByText(/Залишено зі слів власника/)

    const owner = card('OWNER_RECORDED')

    expect(within(owner).getByText('зі слів власника')).toBeInTheDocument()
    expect(
      within(owner).getByText(/Це не відповідь гостя й не його підтвердження/),
    ).toBeInTheDocument()
    expect(within(owner).queryByText('підтверджено гостем')).not.toBeInTheDocument()
    expect(
      within(owner).queryByRole('button', { name: /Скасувати помилкову|Залишити/ }),
    ).not.toBeInTheDocument()
  })

  it('конкурентна зміна (409) на дію: помилка сервера показана і дані перечитано', async () => {
    let gets = 0

    mockServer({
      loans: [],
      confirmations: [denied()],
      patch: () =>
        Promise.reject(
          new ApiRequestError(409, {
            code: 'LOAN_COPY_STATE_MISMATCH',
            message: 'Стан уже змінився',
          }),
        ),
    })
    const original = mockApiRequest.getMockImplementation() as (...args: unknown[]) => unknown

    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/guest-loan-confirmations' && (options?.method ?? 'GET') === 'GET') gets += 1

      return original(path, options)
    })
    render(<GuestLoansScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Залишити зі слів власника' }))
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Залишити зі слів власника',
      }),
    )

    expect(await screen.findByText('Стан уже змінився')).toBeInTheDocument()
    await waitFor(() => {
      expect(gets).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('видача посилання: помилка повторної видачі не повертає старий URL (рев’ю 10i.3)', () => {
  const URL_1 = 'http://localhost:3000/guest-loan-confirmation#token-one'
  const fail = (status: number, code: string) => () =>
    Promise.reject(new ApiRequestError(status, { code, message: 'Видача не вдалася' } as never))

  async function issueFirstCopy(second: () => Promise<unknown>) {
    const server: Server = { loans: [], confirmations: [confirmation()] }

    server.linkResponses = [
      () => {
        server.confirmations = [
          confirmation({ link: { issuedAt: iso(0), expiresAt: iso(7 * DAY), isExpired: false } }),
        ]

        return Promise.resolve({ confirmation: confirmation(), delivery: 'COPY', url: URL_1 })
      },
      second,
    ]
    mockServer(server)
    render(<GuestLoansScreen />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Видати посилання (скопіювати)' }),
    )
    await screen.findByDisplayValue(URL_1)
  }

  it('COPY URL-1 → повторна видача EMAIL падає → URL-1 більше не показується', async () => {
    await issueFirstCopy(fail(502, 'GUEST_LINK_EMAIL_FAILED'))

    await userEvent.type(
      screen.getByLabelText('Тестовий лист: адреса доставки'),
      'again@guest.invalid',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати нове посилання листом' }))

    expect(await screen.findByText('Видача не вдалася')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(URL_1)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('token-one')
    // Успіху транспорту теж не оголошено.
    expect(screen.queryByText(/тестовий поштовий транспорт/)).not.toBeInTheDocument()
  })

  it('COPY URL-1 → повторна COPY-видача падає → URL-1 більше не показується', async () => {
    await issueFirstCopy(fail(500, 'INTERNAL_ERROR'))

    await userEvent.click(
      screen.getByRole('button', { name: 'Видати нове посилання (скопіювати)' }),
    )

    expect(await screen.findByText('Видача не вдалася')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(URL_1)).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('token-one')
  })
})

describe('приватність підтверджених гостем даних (GC7, GC8)', () => {
  it('два запити одного контакту: показані дані названі ПОТОЧНИМИ даними контакту, а не даними саме цієї відповіді', async () => {
    const latest = {
      ...CONTACT,
      guestNickname: 'Пізніший Нік',
      guestEmail: 'later@guest.invalid',
      guestEmailVerifiedAt: '2026-03-01T10:00:00.000Z',
    }

    mockServer({
      loans: [],
      confirmations: [
        confirmation({
          id: 'new',
          status: 'RECEIVED',
          evidence: 'GUEST_CONFIRMED',
          contact: latest,
        }),
        // Старий запит того самого контакту: сервер віддає поточний контакт, не знімок відповіді.
        confirmation({ id: 'old', status: 'DENIED', evidence: 'GUEST_DENIED', contact: latest }),
      ],
    })
    render(<GuestLoansScreen />)

    const details = await screen.findAllByTestId('guest-private-details')

    expect(details).toHaveLength(2)

    for (const item of details) {
      expect(item).toHaveTextContent('поточні підтверджені дані контакту')
      expect(item).toHaveTextContent('не обов’язково з відповіді на цей запит')
      expect(item).toHaveTextContent(
        'Пізніша відповідь цього контакту могла замінити попередні значення',
      )
      expect(item).not.toHaveTextContent(/гість вказав/)
    }
  })

  const received = (contact: GuestLoanConfirmation['contact']) =>
    confirmation({
      status: 'RECEIVED',
      evidence: 'GUEST_CONFIRMED',
      resolvedAt: '2026-02-01T10:00:00.000Z',
      contact,
    })

  it('нікнейм і email гостя (B) видно власнику в приватному контексті; alias власника не змінено; це не доказ особи', async () => {
    mockServer({
      loans: [],
      confirmations: [
        received({
          ...CONTACT,
          guestNickname: 'Нік Гостя',
          guestEmail: 'guest-b@guest.invalid',
          guestEmailVerifiedAt: '2026-02-01T10:00:00.000Z',
        }),
      ],
    })
    render(<GuestLoansScreen />)

    const details = await screen.findByTestId('guest-private-details')

    expect(details).toHaveTextContent('Нік Гостя')
    expect(details).toHaveTextContent('guest-b@guest.invalid')
    expect(details).toHaveTextContent('Мій Псевдонім')
    expect(details).toHaveTextContent(/Це не адреса, на яку ви надсилали лист/)
    expect(screen.getByText(/не доводить особу первісного адресата/)).toBeInTheDocument()
    // alias власника лишається в заголовку картки.
    expect(within(card('RECEIVED')).getByText(/гість: Мій Псевдонім/)).toBeInTheDocument()
  })

  it('DENIED теж показує підтверджені гостем дані (відповідь доведена кодом), лише власнику', async () => {
    mockServer({
      loans: [],
      confirmations: [
        confirmation({
          status: 'DENIED',
          evidence: 'GUEST_DENIED',
          contact: {
            ...CONTACT,
            guestNickname: 'Заперечник',
            guestEmail: 'denier@guest.invalid',
            guestEmailVerifiedAt: '2026-02-01T10:00:00.000Z',
          },
        }),
      ],
    })
    render(<GuestLoansScreen />)

    expect(await screen.findByTestId('guest-private-details')).toHaveTextContent(
      'denier@guest.invalid',
    )
  })

  it('OPEN без відповіді не показує жодних даних гостя (їх ще немає)', async () => {
    mockServer({ loans: [], confirmations: [confirmation()] })
    render(<GuestLoansScreen />)

    await screen.findByText(/ще не підтверджене/)

    expect(screen.queryByTestId('guest-private-details')).not.toBeInTheDocument()
  })

  it('після видалення контакту: факти й джерело лишаються, приватні поля не відновлюються', async () => {
    mockServer({ loans: [], confirmations: [received(null)] })
    render(<GuestLoansScreen />)

    await screen.findAllByText(/Гість підтвердив отримання/)

    const item = card('RECEIVED')

    expect(within(item).getByText(/контакт видалено/)).toBeInTheDocument()
    expect(within(item).getByText('підтверджено гостем')).toBeInTheDocument()
    expect(within(item).queryByTestId('guest-private-details')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('Мій Псевдонім')
  })
})
