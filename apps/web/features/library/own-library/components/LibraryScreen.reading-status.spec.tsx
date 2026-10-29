/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BorrowedLibraryResponse, LibraryResponse, ReadingStatus } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { ReadingStatusPanel } from '@/features/reading-status/index.client'
import { LibraryScreen } from './LibraryScreen'
import { setAddress, watchHistory } from '../own-library.test-helpers'

/**
 * BS-140: the personal reading status on the owner's shelf cards, with the real control, the real
 * batching transport and TanStack Query. Only `apiRequest` is mocked.
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'user-1' } },
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  usePathname: () => '/library',
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: jest.requireActual<typeof import('../own-library.test-helpers')>(
    '../own-library.test-helpers',
  ).useAddressSearchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const AUTHOR = { id: 'author-1', name: 'Ґреґорі Робертс', role: 'AUTHOR', position: 0 }
const BATCH = '/me/reading-statuses?workIds='

function edition(id: string, workId: string, publisher: string) {
  return {
    id,
    workId,
    translationId: null,
    publisher,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    translation: null,
  }
}

function ownCopy(id: string) {
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
  }
}

function group(
  workId: string,
  title: string,
  editionId: string,
  publisher: string,
  copyIds: string[],
) {
  return {
    work: { id: workId, title, origLang: 'en', firstPubYear: null, authors: [AUTHOR] },
    edition: edition(editionId, workId, publisher),
    authors: [AUTHOR],
    copies: copyIds.map(ownCopy),
    counts: { total: copyIds.length, home: copyIds.length, out: 0 },
  }
}

/** «Шантарам» in two editions (the first with two copies) and «Тінь вітру» in one. */
const SHELF = {
  groups: [
    group('work-1', 'Шантарам', 'edition-1', 'Видавництво А', ['copy-1', 'copy-2']),
    group('work-1', 'Шантарам', 'edition-2', 'Видавництво Б', ['copy-3']),
    group('work-2', 'Тінь вітру', 'edition-3', 'Видавництво В', ['copy-4']),
  ],
} as unknown as LibraryResponse

const BORROWED = {
  groups: [
    {
      ...group('work-3', 'Чужа книжка', 'edition-9', 'Видавництво Г', []),
      copies: [
        {
          id: 'copy-7',
          status: 'LENT_OUT',
          condition: 'WORN',
          owner: { id: 'user-2', displayName: 'Марко', handle: '2-user', avatarUrl: null },
          activeLoan: null,
        },
      ],
      counts: { total: 1, home: 0, out: 1 },
    },
  ],
} as unknown as BorrowedLibraryResponse

interface RequestOptions {
  method?: string
  body?: { status: ReadingStatus }
}

let rows: Map<string, ReadingStatus>
let failReads: boolean

function statusOf(workId: string) {
  const status = rows.get(workId)

  return { workId, status: status ?? 'NOT_READ', isSet: status !== undefined, wasBorrowed: false }
}

function serve(shelves: Record<string, unknown> = {}): void {
  mockApiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path in shelves) return Promise.resolve(shelves[path])
    if (path === '/me/library') return Promise.resolve(SHELF)

    if (path.startsWith(BATCH)) {
      if (failReads)
        return Promise.reject(
          new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Немає звʼязку' }),
        )

      return Promise.resolve({
        items: path
          .slice(BATCH.length)
          .split(',')
          .map((id) => ({ requestedWorkId: id, ...statusOf(id) })),
      })
    }

    const single = /^\/me\/reading-statuses\/(.+)$/.exec(path)?.[1]

    if (single !== undefined && options.method === 'PUT' && options.body !== undefined) {
      rows.set(single, options.body.status)

      return Promise.resolve({ workId: single, status: options.body.status })
    }
    if (single !== undefined) return Promise.resolve(statusOf(single))

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function sent(): string[] {
  return mockApiRequest.mock.calls.map(
    ([path, options]: [string, RequestOptions | undefined]) =>
      `${options?.method ?? 'GET'} ${path}`,
  )
}

function controls(title: string): HTMLElement[] {
  return screen.getAllByRole('combobox', { name: `Мій статус читання: «${title}»` })
}

function card(publisher: string): HTMLElement {
  return screen.getByText(new RegExp(publisher)).closest('li.book') as HTMLElement
}

async function chooseOn(trigger: HTMLElement, option: string): Promise<void> {
  await userEvent.click(trigger)
  await userEvent.click(await screen.findByRole('option', { name: option }))
}

let unwatchHistory: () => void = () => undefined

beforeEach(() => {
  mockApiRequest.mockReset()
  mockPush.mockReset()
  rows = new Map()
  failReads = false
  unwatchHistory = watchHistory()
  setAddress()
  serve()
})

afterEach(() => {
  unwatchHistory()
})

describe('статус читання на картках власної полиці (BS-140)', () => {
  it('один контрол на картку — і на картці з двома примірниками; статуси всіх карток одним запитом', async () => {
    rows.set('work-2', 'READ')
    render(withQueryClient(<LibraryScreen />))

    await waitFor(() => {
      expect(controls('Шантарам')).toHaveLength(2)
    })
    expect(within(card('Видавництво А')).getAllByRole('combobox')).toHaveLength(1)
    expect(controls('Шантарам')[0]).toHaveTextContent('Вказати статус читання')
    expect(controls('Тінь вітру')[0]).toHaveTextContent('Прочитано')

    expect(sent()).toEqual(['GET /me/library', `GET ${BATCH}work-1,work-2`])
  })

  it('статус окремо від доступності примірника: свій рядок із підписом «Читання» під примірниками', async () => {
    render(withQueryClient(<LibraryScreen />))

    const trigger = (await screen.findAllByRole('combobox', { name: /Шантарам/ }))[0] as HTMLElement
    const row = trigger.closest('.reading-status') as HTMLElement
    const shelfCard = card('Видавництво А')

    expect(within(row).getByText('Читання')).toBeInTheDocument()
    expect(row.parentElement).toBe(shelfCard)
    // The copies' list (availability, condition, visibility) does not hold the status.
    expect(shelfCard.querySelector('.copies')).not.toContainElement(trigger)
    expect(within(row).queryByText(/Доступна|вдома/i)).toBeNull()
  })

  it('dropdown не всередині посилання картки, а вибір опції книгу не відкриває', async () => {
    render(withQueryClient(<LibraryScreen />))

    const trigger = (
      await screen.findAllByRole('combobox', { name: 'Мій статус читання: «Тінь вітру»' })
    )[0] as HTMLElement

    await waitFor(() => {
      expect(trigger).toHaveTextContent('Вказати статус читання')
    })
    expect(trigger.closest('a')).toBeNull()
    expect(
      within(card('Видавництво В')).getByRole('link', { name: /^Тінь вітру/ }),
    ).not.toContainElement(trigger)
    // Above the stretched link's layer, like the corner menu.
    expect(trigger.closest('.reading-status')).toHaveClass('relative', 'z-10')

    const before = window.location.pathname

    await userEvent.click(trigger)

    const option = await screen.findByRole('option', { name: 'Читаю' })

    // The list opens in a portal: no option is inside the card, so none can reach its link.
    expect(option.closest('li.book')).toBeNull()
    await userEvent.click(option)

    await waitFor(() => {
      expect(controls('Тінь вітру')[0]).toHaveTextContent('Читаю')
    })
    expect(window.location.pathname).toBe(before)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('зміна на картці одного видання одразу видна на картці іншого видання того самого твору, без перечитування полиці', async () => {
    render(withQueryClient(<LibraryScreen />))

    await waitFor(() => {
      expect(controls('Шантарам')[1]).toHaveTextContent('Вказати статус читання')
    })

    await chooseOn(controls('Шантарам')[0] as HTMLElement, 'Прочитано')

    await waitFor(() => {
      expect(controls('Шантарам')[1]).toHaveTextContent('Прочитано')
    })
    expect(within(card('Видавництво А')).getByRole('status')).toHaveTextContent('Збережено')
    expect(sent()).toEqual([
      'GET /me/library',
      `GET ${BATCH}work-1,work-2`,
      'PUT /me/reading-statuses/work-1',
    ])
  })

  it('поки зберігається, обидві картки твору заблоковані й показують «Зберігаю…»', async () => {
    render(withQueryClient(<LibraryScreen />))

    await waitFor(() => {
      expect(controls('Шантарам')[0]).toHaveTextContent('Вказати статус читання')
    })

    let finish: (value: unknown) => void = () => undefined
    const original = mockApiRequest.getMockImplementation()

    mockApiRequest.mockImplementation((path: string, options: RequestOptions = {}) =>
      options.method === 'PUT'
        ? new Promise((resolve) => {
            finish = resolve
          })
        : original?.(path, options),
    )

    await chooseOn(controls('Шантарам')[0] as HTMLElement, 'Читаю')

    for (const trigger of controls('Шантарам')) expect(trigger).toHaveAttribute('data-disabled')
    expect(within(card('Видавництво Б')).getByText('Зберігаю…')).toBeInTheDocument()
    expect(controls('Тінь вітру')[0]).not.toHaveAttribute('data-disabled')

    finish({ workId: 'work-1', status: 'READING' })

    await waitFor(() => {
      expect(controls('Шантарам')[1]).toHaveTextContent('Читаю')
    })
    for (const trigger of controls('Шантарам')) expect(trigger).not.toHaveAttribute('data-disabled')
  })

  it('помилка збереження лишає підтверджений статус і дає явний повтор', async () => {
    rows.set('work-2', 'READING')
    render(withQueryClient(<LibraryScreen />))

    await waitFor(() => {
      expect(controls('Тінь вітру')[0]).toHaveTextContent('Читаю')
    })

    const original = mockApiRequest.getMockImplementation()

    mockApiRequest.mockImplementationOnce(() =>
      Promise.reject(
        new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
      ),
    )
    await chooseOn(controls('Тінь вітру')[0] as HTMLElement, 'Прочитано')

    const shelfCard = card('Видавництво В')

    expect(await within(shelfCard).findByRole('alert')).toHaveTextContent('Сервер недоступний')
    expect(controls('Тінь вітру')[0]).toHaveTextContent('Читаю')

    mockApiRequest.mockImplementation(original as (...args: unknown[]) => unknown)
    await userEvent.click(
      within(shelfCard).getByRole('button', {
        name: 'Спробувати ще раз: статус читання «Тінь вітру»',
      }),
    )

    await waitFor(() => {
      expect(controls('Тінь вітру')[0]).toHaveTextContent('Прочитано')
    })
    expect(within(shelfCard).queryByRole('alert')).toBeNull()
    expect(rows.get('work-2')).toBe('READ')
  })

  it('статус, що не завантажився, — помилка з повтором на картці, а не «не встановлено»; полиця працює далі', async () => {
    failReads = true
    render(withQueryClient(<LibraryScreen />))

    await screen.findByText(/Видавництво В/)

    const shelfCard = card('Видавництво В')

    expect(await within(shelfCard).findByRole('alert')).toHaveTextContent('Статус не завантажено.')
    expect(screen.queryByText('Вказати статус читання')).toBeNull()
    expect(screen.getByRole('link', { name: /^Тінь вітру/ })).toHaveAttribute(
      'href',
      '/library/copy-4',
    )
    expect(screen.getAllByRole('button', { name: /^Дії з примірником/ }).length).toBeGreaterThan(0)

    failReads = false
    await userEvent.click(
      within(shelfCard).getByRole('button', {
        name: 'Спробувати ще раз: статус читання «Тінь вітру»',
      }),
    )

    expect(await within(shelfCard).findByRole('combobox')).toHaveTextContent(
      'Вказати статус читання',
    )
  })

  it.each([
    ['Мої не вдома', '/me/library/out'],
    ['Архів', '/me/library?archived=true'],
  ])('«%s» теж має контрол статусу', async (tab, path) => {
    serve({ [path]: { groups: [SHELF.groups[2]] } })
    render(withQueryClient(<LibraryScreen />))

    await userEvent.click(await screen.findByRole('tab', { name: tab }))

    expect(
      await screen.findByRole('combobox', { name: 'Мій статус читання: «Тінь вітру»' }),
    ).toBeInTheDocument()
  })

  it('«Чужі в мене» контролу статусу не має', async () => {
    serve({ '/me/library/borrowed': BORROWED })
    render(withQueryClient(<LibraryScreen />))

    await userEvent.click(await screen.findByRole('tab', { name: 'Чужі в мене' }))

    expect(await screen.findByRole('link', { name: /^Чужа книжка/ })).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: /Мій статус читання/ })).toBeNull()
    expect(sent().filter((request) => request.includes('reading-statuses'))).toEqual([
      `GET ${BATCH}work-1,work-2`,
    ])
  })

  it('картки й панель сторінки книги — одне джерело: зміна на панелі одразу на картках', async () => {
    const client = createTestQueryClient()

    render(
      withQueryClient(
        <>
          <LibraryScreen />
          <ReadingStatusPanel workId="work-1" />
        </>,
        client,
      ),
    )

    await waitFor(() => {
      expect(controls('Шантарам')[0]).toHaveTextContent('Вказати статус читання')
    })

    await chooseOn(screen.getByRole('combobox', { name: 'Мій статус читання' }), 'Прочитано')

    await waitFor(() => {
      for (const trigger of controls('Шантарам')) expect(trigger).toHaveTextContent('Прочитано')
    })
  })
})
