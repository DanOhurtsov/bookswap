/** @jest-environment jsdom */

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BorrowedLibraryResponse, LibraryResponse, OwnCopy } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { LibraryScreen } from './LibraryScreen'
import { setAddress, watchHistory } from '../own-library.test-helpers'

/**
 * Characterization of the shelf as it behaves today: the session guard, the four views, the filter
 * form, every action on a copy row and the lock while an action is in flight. It exists so the file
 * can be split without anyone having to remember what the screen does. Where the behavior is an
 * accident of the current structure rather than a decision, the test name says "поки що".
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let mockSession: Record<string, unknown> = {}

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: mockSession,
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: jest.requireActual<typeof import('../own-library.test-helpers')>(
    '../own-library.test-helpers',
  ).useAddressSearchParams,
}))

// The two forms are covered by their own specs; here only how the row wires them matters.
jest.mock('./RecordExistingLoanForm', () => ({
  RecordExistingLoanForm: ({
    copyId,
    onRecorded,
    onCancel,
  }: {
    copyId: string
    onRecorded: () => Promise<void>
    onCancel: () => void
  }) => (
    <div>
      <p>форма запису {copyId}</p>
      <button type="button" onClick={() => void onRecorded()}>
        заглушка: записано
      </button>
      <button type="button" onClick={onCancel}>
        заглушка: скасувати запис
      </button>
    </div>
  ),
}))

jest.mock('@/features/guest-loans/index.client', () => ({
  CreateGuestLoanForm: ({
    copyId,
    onCreated,
    onCancel,
  }: {
    copyId: string
    onCreated: () => Promise<void>
    onCancel: () => void
  }) => (
    <div>
      <p>форма гостя {copyId}</p>
      <button type="button" onClick={() => void onCreated()}>
        заглушка: створено
      </button>
      <button type="button" onClick={onCancel}>
        заглушка: скасувати гостя
      </button>
    </div>
  ),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

beforeAll(() => {
  // jsdom has no `PointerEvent`; Base UI builds one to activate a menu item from the keyboard.
  window.PointerEvent ??= class PointerEvent extends MouseEvent {} as typeof window.PointerEvent
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

let unwatchHistory: () => void = () => undefined

afterEach(() => {
  unwatchHistory()
})

beforeEach(() => {
  mockApiRequest.mockReset()
  mockReplace.mockReset()
  unwatchHistory = watchHistory()
  setAddress()
  mockSession = { status: 'authenticated', user: { id: 'user-1' }, features: { guestLoans: false } }
})

// --- Fixtures and helpers ----------------------------------------------------

const AUTHOR = { id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }

const WORK = {
  id: 'work-1',
  title: 'Шантарам',
  origLang: 'en',
  firstPubYear: null,
  authors: [AUTHOR],
}

const EDITION = {
  id: 'edition-1',
  workId: 'work-1',
  translationId: null,
  publisher: null,
  year: null,
  isbn13: null,
  pageCount: null,
  coverUrl: null,
  format: 'PAPERBACK',
  translation: null,
}

function ownCopy(id: string, overrides: Record<string, unknown> = {}): OwnCopy {
  return {
    id,
    status: 'AVAILABLE',
    visibility: 'FRIENDS',
    condition: 'GOOD',
    note: null,
    acquiredAt: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    isHome: true,
    holder: null,
    activeLoan: null,
    pendingRequestCount: 0,
    ...overrides,
  } as unknown as OwnCopy
}

function shelfOf(...copies: OwnCopy[]): LibraryResponse {
  const home = copies.filter((copy) => copy.isHome).length

  return {
    groups: [
      {
        work: WORK,
        edition: EDITION,
        authors: [AUTHOR],
        copies,
        counts: { total: copies.length, home, out: copies.length - home },
      },
    ],
  } as unknown as LibraryResponse
}

const EMPTY = { groups: [] }

const BORROWED = {
  groups: [
    {
      work: WORK,
      edition: EDITION,
      authors: [AUTHOR],
      copies: [
        {
          id: 'copy-7',
          status: 'LENT_OUT',
          condition: 'WORN',
          owner: { id: 'user-2', displayName: 'Марко' },
          activeLoan: { id: 'loan-7' },
        },
        {
          id: 'copy-8',
          status: 'LENT_OUT',
          condition: 'NEW',
          owner: { id: 'user-3', displayName: 'Олена' },
          activeLoan: null,
        },
      ],
      counts: { total: 2, home: 0, out: 2 },
    },
  ],
} as unknown as BorrowedLibraryResponse

type Routes = Record<string, () => unknown>

/** Answers exactly the listed `METHOD path` requests; anything else rejects, so a stray request fails loudly. */
function serve(routes: Routes): void {
  mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? 'GET'} ${path}`
    const route = routes[key]

    if (route === undefined) return Promise.reject(new Error(`unexpected request: ${key}`))

    return new Promise((resolve) => {
      resolve(route())
    })
  })
}

function sent(): string[] {
  return mockApiRequest.mock.calls.map(
    ([path, options]: [string, { method?: string } | undefined]) =>
      `${options?.method ?? 'GET'} ${path}`,
  )
}

function deferred(): { promise: Promise<unknown>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<unknown>((done) => {
    resolve = () => {
      done({})
    }
  })

  return { promise, resolve }
}

function renderShelf(): void {
  render(withQueryClient(<LibraryScreen />))
}

const button = (name: string) => screen.getByRole('button', { name })
const queryButton = (name: string) => screen.queryByRole('button', { name })

// A copy's actions are in the menu behind its ⋮ button, one menu per copy.
const MENU_TRIGGER = /^Дії з примірником/
const menuTriggers = () => screen.findAllByRole('button', { name: MENU_TRIGGER })
const item = (name: string) => screen.getByRole('menuitem', { name })
const queryItem = (name: string) => screen.queryByRole('menuitem', { name })

async function openMenu(copyIndex = 0): Promise<void> {
  const triggers = await menuTriggers()

  await userEvent.click(triggers[copyIndex] as HTMLElement)
}

async function choose(name: string, copyIndex = 0): Promise<void> {
  await openMenu(copyIndex)
  await userEvent.click(await screen.findByRole('menuitem', { name }))
}

// --- Session guard -----------------------------------------------------------

describe('охоронець сесії', () => {
  it('поки сесію перевіряють, показує статус і нічого не вантажить', () => {
    mockSession = { status: 'loading' }

    renderShelf()

    expect(screen.getByRole('heading', { name: 'Моя бібліотека' })).toBeInTheDocument()
    expect(screen.getByText('Перевіряю сесію…')).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('гостя переадресовує на /login і нічого не вантажить', () => {
    mockSession = { status: 'guest' }

    renderShelf()

    expect(screen.getByText('Потрібен вхід. Переадресовую…')).toBeInTheDocument()
    expect(mockReplace).toHaveBeenCalledWith('/login')
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('помилку сесії показує повідомленням', () => {
    mockSession = { status: 'error', message: 'Сервер недоступний' }

    renderShelf()

    expect(screen.getByRole('alert')).toHaveTextContent('Сервер недоступний')
    expect(mockApiRequest).not.toHaveBeenCalled()
  })
})

// --- Views and filters -------------------------------------------------------

describe('в’ю й фільтр', () => {
  it('«Усі мої»: читає /me/library, показує лише поле «Назва або автор» і єдине посилання внизу', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    expect(await screen.findByLabelText('Назва або автор')).toBeInTheDocument()
    expect(screen.queryByLabelText('Доступність')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Мова')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Імпорт із CSV' })).toHaveAttribute(
      'href',
      '/library/imports',
    )
    expect(sent()).toEqual(['GET /me/library'])
  })

  it('«Застосувати» шле запит з q, а порожній запит — без параметрів', async () => {
    const filtered = `GET /me/library?${new URLSearchParams({ q: 'Шантарам' }).toString()}`

    serve({
      'GET /me/library': () => EMPTY,
      [filtered]: () => EMPTY,
    })

    renderShelf()
    await userEvent.type(await screen.findByLabelText('Назва або автор'), 'Шантарам')
    await userEvent.click(button('Застосувати'))

    await waitFor(() => {
      expect(sent()).toContain(filtered)
    })

    await userEvent.clear(screen.getByLabelText('Назва або автор'))
    await userEvent.click(button('Застосувати'))

    await waitFor(() => {
      expect(sent().filter((request) => request === 'GET /me/library')).toHaveLength(2)
    })
  })

  it('«Мої не вдома» читає /me/library/out без форми фільтра; «Архів» теж без неї', async () => {
    serve({
      'GET /me/library': () => EMPTY,
      'GET /me/library/out': () => EMPTY,
      'GET /me/library?archived=true': () => EMPTY,
    })

    renderShelf()
    await screen.findByLabelText('Назва або автор')

    await userEvent.click(screen.getByRole('tab', { name: 'Мої не вдома' }))
    await waitFor(() => {
      expect(sent()).toContain('GET /me/library/out')
    })
    expect(screen.queryByLabelText('Назва або автор')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Архів' }))
    await waitFor(() => {
      expect(sent()).toContain('GET /me/library?archived=true')
    })
    expect(screen.queryByLabelText('Назва або автор')).not.toBeInTheDocument()
  })

  it.each([
    ['Усі мої', 'Полиця порожня. Знайдіть книжку в каталозі — і додайте примірник.'],
    ['Мої не вдома', 'Усі ваші книжки вдома.'],
    ['Архів', 'Архів порожній.'],
    ['Чужі в мене', 'Чужих книжок у вас зараз немає.'],
  ])('порожня полиця «%s» пояснює, що вона порожня', async (tab, message) => {
    serve({
      'GET /me/library': () => EMPTY,
      'GET /me/library/out': () => EMPTY,
      'GET /me/library?archived=true': () => EMPTY,
      'GET /me/library/borrowed': () => EMPTY,
    })

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: tab }))

    expect(await screen.findByText(message)).toBeInTheDocument()
  })
})

// --- Address -----------------------------------------------------------------

describe('адреса бібліотеки', () => {
  const FILTERED_PATH = `/me/library?${new URLSearchParams({ q: 'абв' }).toString()}`
  const FILTERED = `GET ${FILTERED_PATH}`
  const ROUTES: Routes = {
    'GET /me/library': () => EMPTY,
    [FILTERED]: () => EMPTY,
    'GET /me/library/out': () => EMPTY,
    'GET /me/library?archived=true': () => EMPTY,
    'GET /me/library/borrowed': () => EMPTY,
  }

  it('вкладка пишеться в адресу замість запису в історії', async () => {
    serve(ROUTES)
    const entries = window.history.length

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: 'Мої не вдома' }))

    expect(window.location.search).toBe('?view=out')

    await userEvent.click(screen.getByRole('tab', { name: 'Архів' }))

    expect(window.location.search).toBe('?view=archive')

    await userEvent.click(screen.getByRole('tab', { name: 'Усі мої' }))

    expect(window.location.search).toBe('')
    expect(window.history.length).toBe(entries)
  })

  it.each([
    ['?view=out', 'Мої не вдома', 'GET /me/library/out'],
    ['?view=borrowed', 'Чужі в мене', 'GET /me/library/borrowed'],
    ['?view=archive', 'Архів', 'GET /me/library?archived=true'],
  ])('пряме посилання %s відкриває «%s» і вантажить лише її', async (search, tab, request) => {
    serve(ROUTES)
    setAddress(search)

    renderShelf()

    expect(await screen.findByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => {
      expect(sent()).toEqual([request])
    })
  })

  it('пряме посилання з фільтром заповнює поле й вантажить уже відфільтровану полицю', async () => {
    serve(ROUTES)
    setAddress(`?q=${encodeURIComponent('абв')}`)

    renderShelf()

    expect(await screen.findByLabelText('Назва або автор')).toHaveValue('абв')
    await waitFor(() => {
      expect(sent()).toEqual([FILTERED])
    })
  })

  it('«Застосувати» пише фільтр в адресу й додає запис в історії; повторне застосування нічого не додає', async () => {
    serve(ROUTES)
    const entries = window.history.length

    renderShelf()
    await userEvent.type(await screen.findByLabelText('Назва або автор'), 'абв')
    await userEvent.click(button('Застосувати'))

    await waitFor(() => {
      expect(sent()).toContain(FILTERED)
    })
    expect(window.location.search).toBe(`?q=${encodeURIComponent('абв')}`)
    expect(window.history.length).toBe(entries + 1)

    await userEvent.click(button('Застосувати'))

    expect(window.history.length).toBe(entries + 1)
  })

  it('поле обрізає те, що застосовано: після «Застосувати» в ньому те, що в адресі', async () => {
    serve(ROUTES)

    renderShelf()
    await userEvent.type(await screen.findByLabelText('Назва або автор'), '  абв  ')
    await userEvent.click(button('Застосувати'))

    await waitFor(() => {
      expect(screen.getByLabelText('Назва або автор')).toHaveValue('абв')
    })
  })

  it('фільтр належить «Усі мої»: вихід на іншу вкладку скидає його, повернення починає з чистого', async () => {
    serve(ROUTES)

    renderShelf()
    await userEvent.type(await screen.findByLabelText('Назва або автор'), 'абв')
    await userEvent.click(button('Застосувати'))
    await waitFor(() => {
      expect(sent()).toContain(FILTERED)
    })

    await userEvent.click(screen.getByRole('tab', { name: 'Мої не вдома' }))

    expect(window.location.search).toBe('?view=out')

    await userEvent.click(screen.getByRole('tab', { name: 'Усі мої' }))

    expect(await screen.findByLabelText('Назва або автор')).toHaveValue('')
    await waitFor(() => {
      expect(sent().at(-1)).toBe('GET /me/library')
    })
  })

  it('«назад» повертає попередню полицю й чистить поле', async () => {
    serve(ROUTES)

    renderShelf()
    await userEvent.type(await screen.findByLabelText('Назва або автор'), 'абв')
    await userEvent.click(button('Застосувати'))
    await waitFor(() => {
      expect(sent()).toContain(FILTERED)
    })

    act(() => {
      window.history.back()
    })

    await waitFor(() => {
      expect(screen.getByLabelText('Назва або автор')).toHaveValue('')
    })
    expect(window.location.search).toBe('')
    await waitFor(() => {
      expect(sent().at(-1)).toBe('GET /me/library')
    })
  })

  it('нерозбірлива адреса показується як типова й виправляється без запису в історії', async () => {
    serve(ROUTES)
    setAddress('?view=bogus')
    const entries = window.history.length

    renderShelf()

    expect(await screen.findByRole('tab', { name: 'Усі мої' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await waitFor(() => {
      expect(window.location.search).toBe('')
    })
    expect(window.history.length).toBe(entries)
  })
})

// --- Borrowed view -----------------------------------------------------------

describe('«Чужі в мене»', () => {
  it('поки вантажиться, показує статус', async () => {
    serve({
      'GET /me/library': () => EMPTY,
      'GET /me/library/borrowed': () => new Promise(() => undefined),
    })

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: 'Чужі в мене' }))

    expect(screen.getByText('Завантажую полицю…')).toBeInTheDocument()
  })

  it('помилку читання показує повідомленням', async () => {
    serve({
      'GET /me/library': () => EMPTY,
      'GET /me/library/borrowed': () => {
        throw new Error('Не вдалося завантажити')
      },
    })

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: 'Чужі в мене' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  it('показує групу, власника кожного примірника й посилання на позичання та історію', async () => {
    serve({ 'GET /me/library': () => EMPTY, 'GET /me/library/borrowed': () => BORROWED })

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: 'Чужі в мене' }))

    expect(await screen.findByRole('link', { name: /Шантарам ×2/ })).toHaveAttribute(
      'href',
      '/works/work-1',
    )
    expect(screen.getByText(/0 вдома · 2 не вдома/)).toBeInTheDocument()
    expect(screen.getByText(/Потерта · власник: Марко/)).toBeInTheDocument()
    expect(screen.getByText(/Як нова · власник: Олена/)).toBeInTheDocument()
    // Only the copy that has an active loan links to it, and as the borrower.
    expect(screen.getByRole('link', { name: 'Моє позичання' })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-7&role=borrower',
    )
    expect(
      screen.getAllByRole('link', { name: 'Історія' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/copies/copy-7/history', '/copies/copy-8/history'])
    expect(queryButton('Редагувати')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: MENU_TRIGGER })).not.toBeInTheDocument()
  })
})

// --- Copy row: what is offered -----------------------------------------------

describe('рядок примірника: які дії пропонуються', () => {
  const ALL = [
    'Редагувати',
    'Тимчасово не даю',
    'Знову даю',
    'Записати передану книжку',
    'Позичити гостю',
    'Архівувати',
    'Видалити',
  ]

  it.each([
    {
      name: 'вдома й вільний',
      copy: { status: 'AVAILABLE', isHome: true },
      guestLoans: false,
      offered: [
        'Редагувати',
        'Тимчасово не даю',
        'Записати передану книжку',
        'Архівувати',
        'Видалити',
      ],
    },
    {
      name: 'вдома й вільний, гостьові позики ввімкнені',
      copy: { status: 'AVAILABLE', isHome: true },
      guestLoans: true,
      offered: [
        'Редагувати',
        'Тимчасово не даю',
        'Записати передану книжку',
        'Позичити гостю',
        'Архівувати',
        'Видалити',
      ],
    },
    {
      name: 'вдома, але тимчасово не даю (гостьові ввімкнені)',
      copy: { status: 'UNAVAILABLE', isHome: true },
      guestLoans: true,
      offered: ['Редагувати', 'Знову даю', 'Архівувати', 'Видалити'],
    },
    {
      name: 'у позичальника',
      copy: { status: 'LENT_OUT', isHome: false },
      guestLoans: true,
      offered: ['Редагувати', 'Архівувати', 'Видалити'],
    },
    {
      name: 'вільний, але не вдома',
      copy: { status: 'AVAILABLE', isHome: false },
      guestLoans: true,
      offered: ['Редагувати', 'Архівувати', 'Видалити'],
    },
  ])('$name', async ({ copy, guestLoans, offered }) => {
    mockSession = { ...mockSession, features: { guestLoans } }
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1', copy)) })

    renderShelf()
    await openMenu()
    await screen.findByRole('menuitem', { name: 'Редагувати' })

    for (const name of ALL) {
      if (offered.includes(name)) expect(item(name)).toBeInTheDocument()
      else expect(queryItem(name)).not.toBeInTheDocument()
    }
  })

  it('без features у сесії гостьові позики вважаються вимкненими', async () => {
    mockSession = { status: 'authenticated', user: { id: 'user-1' } }
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await openMenu()
    await screen.findByRole('menuitem', { name: 'Редагувати' })

    expect(queryItem('Позичити гостю')).not.toBeInTheDocument()
  })

  it('мета-рядок: позичання, черга запитів, історія й нотатка ведуть куди слід', async () => {
    serve({
      'GET /me/library': () =>
        shelfOf(
          ownCopy('copy-1', {
            status: 'LENT_OUT',
            isHome: false,
            note: 'з автографом',
            holder: { id: 'user-2', displayName: 'Марко' },
            activeLoan: {
              id: 'loan-1',
              status: 'HANDED_OVER',
              counterpart: { id: 'user-2', displayName: 'Марко' },
            },
            pendingRequestCount: 2,
          }),
        ),
    })

    renderShelf()

    expect(await screen.findByRole('link', { name: /^Позичання: Марко/ })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-1&role=owner',
    )
    expect(screen.getByRole('link', { name: 'Запитів: 2' })).toHaveAttribute(
      'href',
      '/loans?role=owner',
    )
    expect(screen.getByRole('link', { name: 'Історія' })).toHaveAttribute(
      'href',
      '/copies/copy-1/history',
    )
    expect(screen.getByText(/у Марко/)).toBeInTheDocument()
    expect(screen.getByText('Нотатка: з автографом')).toBeInTheDocument()
  })
})

// --- Copy row: actions -------------------------------------------------------

describe('рядок примірника: дії', () => {
  it.each([
    ['AVAILABLE', 'Тимчасово не даю', 'UNAVAILABLE'],
    ['UNAVAILABLE', 'Знову даю', 'AVAILABLE'],
  ])('%s: «%s» шле PATCH { status: %s } і перечитує полицю', async (status, label, next) => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1', { status })),
      'PATCH /me/library/copy-1': () => ({}),
    })

    renderShelf()
    await choose(label)

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library/copy-1',
        expect.objectContaining({ method: 'PATCH', body: { status: next } }),
      )
    })
    await waitFor(() => {
      expect(sent().filter((request) => request === 'GET /me/library')).toHaveLength(2)
    })
  })

  it('«Редагувати»: відкриває форму у вікні, зберігає всі чотири поля одним PATCH, закриває вікно й перечитує полицю', async () => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1')),
      'PATCH /me/library/copy-1': () => ({}),
    })

    renderShelf()
    await choose('Редагувати')

    expect(screen.getByRole('dialog', { name: 'Редагувати примірник' })).toBeInTheDocument()

    await userEvent.selectOptions(screen.getByLabelText('Стан'), 'WORN')
    await userEvent.type(screen.getByLabelText('Нотатка'), 'нова нотатка')
    await userEvent.click(button('Зберегти'))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library/copy-1',
        expect.objectContaining({
          method: 'PATCH',
          body: {
            condition: 'WORN',
            visibility: 'FRIENDS',
            note: 'нова нотатка',
            acquiredAt: null,
          },
        }),
      )
    })
    await waitFor(() => {
      expect(sent().filter((request) => request === 'GET /me/library')).toHaveLength(2)
    })
    expect(await menuTriggers()).toHaveLength(1)
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  it('порожня нотатка зберігається як null', async () => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1', { note: 'стара' })),
      'PATCH /me/library/copy-1': () => ({}),
    })

    renderShelf()
    await choose('Редагувати')
    await userEvent.clear(screen.getByLabelText('Нотатка'))
    await userEvent.click(button('Зберегти'))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library/copy-1',
        expect.objectContaining({ body: expect.objectContaining({ note: null }) }),
      )
    })
  })

  it('відмова сервера показується, а вікно лишається відкритим і полиця не перечитується', async () => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1')),
      'PATCH /me/library/copy-1': () => {
        throw new ApiRequestError(409, { code: 'CONFLICT', message: 'Примірник змінився' })
      },
    })

    renderShelf()
    await choose('Редагувати')
    await userEvent.click(button('Зберегти'))

    expect(await screen.findByText('Примірник змінився')).toBeInTheDocument()
    expect(button('Зберегти')).toBeEnabled()
    expect(screen.getByLabelText('Нотатка')).toBeInTheDocument()
    expect(sent().filter((request) => request === 'GET /me/library')).toHaveLength(1)
  })

  it('поки що: «Скасувати» закриває вікно без запиту, але чернетка лишається до наступного відкриття', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await choose('Редагувати')
    await userEvent.type(screen.getByLabelText('Нотатка'), 'чернетка')
    await userEvent.click(button('Скасувати'))

    await waitFor(() => {
      expect(screen.queryByLabelText('Нотатка')).not.toBeInTheDocument()
    })
    expect(sent()).toEqual(['GET /me/library'])

    await choose('Редагувати')

    expect(screen.getByLabelText('Нотатка')).toHaveValue('чернетка')
  })

  it('«Записати передану книжку»: форма у вікні; скасування закриває його без запитів; запис перечитує полицю', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await choose('Записати передану книжку')

    expect(screen.getByRole('dialog', { name: 'Записати передану книжку' })).toBeInTheDocument()
    expect(screen.getByText('форма запису copy-1')).toBeInTheDocument()

    await userEvent.click(button('заглушка: скасувати запис'))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent()).toEqual(['GET /me/library'])

    await choose('Записати передану книжку')
    await userEvent.click(button('заглушка: записано'))

    await waitFor(() => {
      expect(sent()).toEqual(['GET /me/library', 'GET /me/library'])
    })
  })

  it('«Позичити гостю»: те саме для форми гостя', async () => {
    mockSession = { ...mockSession, features: { guestLoans: true } }
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await choose('Позичити гостю')

    expect(screen.getByRole('dialog', { name: 'Позичити гостю' })).toBeInTheDocument()
    expect(screen.getByText('форма гостя copy-1')).toBeInTheDocument()

    await userEvent.click(button('заглушка: скасувати гостя'))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(sent()).toEqual(['GET /me/library'])

    await choose('Позичити гостю')
    await userEvent.click(button('заглушка: створено'))

    await waitFor(() => {
      expect(sent()).toEqual(['GET /me/library', 'GET /me/library'])
    })
  })
})

// --- Lock and delete ---------------------------------------------------------

describe('блокування та видалення', () => {
  it('поки триває архівація, меню рядка заблоковане; потім полиця повертається доступною', async () => {
    const archiving = deferred()

    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1')),
      'POST /me/library/copy-1/archive': () => archiving.promise,
    })

    renderShelf()
    await choose('Архівувати')

    await waitFor(() => {
      expect(screen.getByRole('button', { name: MENU_TRIGGER })).toBeDisabled()
    })

    archiving.resolve()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: MENU_TRIGGER })).toBeEnabled()
    })
  })

  it('«Скасувати» в діалозі видалення не шле DELETE', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await choose('Видалити')
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Скасувати' }),
    )

    expect(sent()).toEqual(['GET /me/library'])
  })

  it('невдале видалення показує повідомлення й закриває діалог', async () => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1')),
      'DELETE /me/library/copy-1': () => {
        throw new ApiRequestError(409, { code: 'CONFLICT', message: 'У примірника є історія' })
      },
    })

    renderShelf()
    await choose('Видалити')
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Видалити' }),
    )

    expect(await screen.findByText('У примірника є історія')).toBeInTheDocument()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('поки що: архівація сусіднього примірника перечитує полицю, і рядки з’являються заново з порожньою чернеткою', async () => {
    serve({
      'GET /me/library': () => shelfOf(ownCopy('copy-1'), ownCopy('copy-2')),
      'POST /me/library/copy-2/archive': () => ({}),
    })

    renderShelf()
    await choose('Редагувати', 0)
    await userEvent.type(screen.getByLabelText('Нотатка'), 'незбережене')
    await userEvent.click(button('Скасувати'))
    await waitFor(() => {
      expect(screen.queryByLabelText('Нотатка')).not.toBeInTheDocument()
    })
    await choose('Архівувати', 1)

    await waitFor(() => {
      expect(sent().filter((request) => request === 'GET /me/library')).toHaveLength(2)
    })
    expect(await menuTriggers()).toHaveLength(2)

    await choose('Редагувати', 0)

    expect(screen.getByLabelText('Нотатка')).toHaveValue('')
  })
})

// --- The card is a link ------------------------------------------------------

describe('картка книги', () => {
  it('усю картку веде на сторінку першого примірника /library/:copyId, а заголовок — її посилання', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1'), ownCopy('copy-2')) })

    renderShelf()

    const title = await screen.findByRole('link', { name: /^Шантарам/ })

    // The page is the copy's, not the edition's: the owner can hold several copies of one book.
    expect(title).toHaveAttribute('href', '/library/copy-1')
    // The one link covers the card: it carries the layer that is stretched over it.
    expect(title).toHaveClass('after:absolute', 'after:inset-0')
    expect(title.closest('li.book')).toHaveClass('relative', 'hover:bg-muted/50')
  })

  it('кожен примірник групи з кількох має власне «Відкрити» на свою сторінку', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1'), ownCopy('copy-2')) })

    renderShelf()
    await screen.findByRole('link', { name: /^Шантарам/ })

    expect(
      screen.getAllByRole('link', { name: 'Відкрити' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/library/copy-1', '/library/copy-2'])
  })

  it('єдиний примірник: картка вже веде на нього, окремого «Відкрити» в рядку немає', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/library/copy-1',
    )
    expect(screen.queryByRole('link', { name: 'Відкрити' })).not.toBeInTheDocument()
  })

  it.each([
    ['Мої не вдома', 'GET /me/library/out'],
    ['Архів', 'GET /me/library?archived=true'],
  ])('вʼю «%s»: картка теж веде на /library/:copyId', async (tab, request) => {
    serve({
      'GET /me/library': () => EMPTY,
      [request]: () => shelfOf(ownCopy('copy-9'), ownCopy('copy-10')),
    })

    renderShelf()
    await userEvent.click(await screen.findByRole('tab', { name: tab }))

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/library/copy-9',
    )
    expect(
      screen.getAllByRole('link', { name: 'Відкрити' }).map((a) => a.getAttribute('href')),
    ).toEqual(['/library/copy-9', '/library/copy-10'])
  })

  it('відфільтрована полиця: картка веде на /library/:copyId', async () => {
    setAddress('?q=Shan')
    serve({ 'GET /me/library?q=Shan': () => shelfOf(ownCopy('copy-5')) })

    renderShelf()

    expect(await screen.findByRole('link', { name: /^Шантарам/ })).toHaveAttribute(
      'href',
      '/library/copy-5',
    )
  })

  it('усе інтерактивне на картці лежить над шаром посилання', async () => {
    serve({
      'GET /me/library': () =>
        shelfOf(
          ownCopy('copy-1', {
            activeLoan: {
              id: 'loan-1',
              status: 'HANDED_OVER',
              counterpart: { id: 'user-2', displayName: 'Марко' },
            },
            pendingRequestCount: 1,
          }),
        ),
    })

    renderShelf()

    for (const link of [
      await screen.findByRole('link', { name: /^Позичання: Марко/ }),
      screen.getByRole('link', { name: 'Запитів: 1' }),
      screen.getByRole('link', { name: 'Історія' }),
      screen.getByRole('button', { name: MENU_TRIGGER }),
    ]) {
      expect(link).toHaveClass('relative', 'z-10')
    }
  })

  it('на картці нема жодної кнопки, крім ⋮ кожного примірника', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1'), ownCopy('copy-2')) })

    renderShelf()
    await menuTriggers()

    const card = screen.getByRole('link', { name: /^Шантарам/ }).closest('li.book') as HTMLElement
    const buttons = within(card).getAllByRole('button')

    expect(buttons).toHaveLength(2)
    expect(
      buttons.every((candidate) => MENU_TRIGGER.test(candidate.getAttribute('aria-label') ?? '')),
    ).toBe(true)
  })

  it('з клавіатури: Tab веде до посилання картки, потім до ⋮; Enter відкриває меню, стрілки рухають фокус, Enter обирає пункт', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    const title = await screen.findByRole('link', { name: /^Шантарам/ })
    const trigger = screen.getByRole('button', { name: MENU_TRIGGER })

    title.focus()
    await userEvent.tab()

    // Between the title and the ⋮ there is only the copy's own link.
    expect(screen.getByRole('link', { name: 'Історія' })).toHaveFocus()

    await userEvent.tab()

    expect(trigger).toHaveFocus()

    await userEvent.keyboard('{Enter}')

    // Opened from the keyboard, the menu puts the focus on its first item; the arrows move it.
    await waitFor(() => {
      expect(screen.getByRole('menuitem', { name: 'Редагувати' })).toHaveFocus()
    })

    await userEvent.keyboard('{ArrowDown}')

    expect(screen.getByRole('menuitem', { name: 'Тимчасово не даю' })).toHaveFocus()

    await userEvent.keyboard('{ArrowUp}{Enter}')

    expect(await screen.findByRole('dialog', { name: 'Редагувати примірник' })).toBeInTheDocument()
    // The dialog takes the focus, so the card's link cannot be reached through it.
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement)
  })

  it('Esc закриває меню й повертає фокус на ⋮', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()
    await openMenu()
    await screen.findByRole('menuitem', { name: 'Редагувати' })
    await userEvent.keyboard('{Escape}')

    await waitFor(() => {
      expect(queryItem('Редагувати')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: MENU_TRIGGER })).toHaveFocus()
  })

  it('єдиний примірник: ⋮ у правому верхньому куті картки, а заголовок не заходить під нього', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    const trigger = await screen.findByRole('button', { name: MENU_TRIGGER })
    const card = screen.getByRole('link', { name: /^Шантарам/ }).closest('li.book') as HTMLElement

    expect(trigger.parentElement).toHaveClass('absolute', 'top-2', 'right-2')
    expect(card).toContainElement(trigger)
    expect(screen.getByRole('link', { name: /^Шантарам/ }).parentElement).toHaveClass('pr-10')
  })

  it('кілька примірників: ⋮ кожного лишається в правому верхньому куті свого рядка', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1'), ownCopy('copy-2')) })

    renderShelf()

    for (const trigger of await menuTriggers()) {
      expect(trigger.parentElement).not.toHaveClass('absolute')
      expect(trigger.closest('li.copy')).not.toBeNull()
    }
    expect(screen.getByRole('link', { name: /^Шантарам/ }).parentElement).not.toHaveClass('pr-10')
  })

  it('архів: єдиний примірник теж із ⋮ у куті картки', async () => {
    setAddress('?view=archive')
    serve({ 'GET /me/library?archived=true': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    expect((await screen.findByRole('button', { name: MENU_TRIGGER })).parentElement).toHaveClass(
      'absolute',
      'top-2',
      'right-2',
    )
  })

  it('кожне меню названо за книгою, тож кнопки ⋮ відрізняються для екранного читача від сусідніх карток', async () => {
    serve({ 'GET /me/library': () => shelfOf(ownCopy('copy-1')) })

    renderShelf()

    expect(
      await screen.findByRole('button', { name: 'Дії з примірником «Шантарам»' }),
    ).toBeInTheDocument()
  })
})
