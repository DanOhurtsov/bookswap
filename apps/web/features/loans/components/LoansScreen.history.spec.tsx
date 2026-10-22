/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MyHistoryEntry, MyHistoryResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import type { SessionState } from '@/app/lib/use-session'
import { LoansScreen } from './LoansScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
let mockParameters = new URLSearchParams()

jest.mock('next/navigation', () => ({
  usePathname: () => '/loans',
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  useSearchParams: () => mockParameters,
}))

const mockSession: SessionState = {
  status: 'authenticated',
  user: {
    id: 'user-me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Я',
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

jest.mock('@/app/lib/use-session', () => ({ useSession: () => ({ state: mockSession }) }))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const requestedPaths = () => apiRequest.mock.calls.map(([path]) => path as string)

function copyOf(id: string, title: string): MyHistoryEntry['copy'] {
  return {
    id: `copy-${id}`,
    status: 'AVAILABLE',
    condition: 'GOOD',
    edition: {
      id: `ed-${id}`,
      workId: `work-${id}`,
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
    },
    work: {
      id: `work-${id}`,
      title,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
  }
}

const BORROWED: MyHistoryEntry = {
  entry: {
    names: true,
    loanId: 'loan-1',
    owner: { id: 'user-marta', displayName: 'Марта', avatarUrl: null },
    borrower: { id: 'user-me', displayName: 'Я', avatarUrl: null },
    status: 'RETURNED',
    isOverdue: false,
    origin: 'REQUESTED',
    guestEvidence: null,
    requestedAt: '2026-01-01T00:00:00.000Z',
    respondedAt: null,
    handedAt: '2026-01-05T00:00:00.000Z',
    returnedAt: '2026-02-01T00:00:00.000Z',
    dueAt: null,
  },
  copy: copyOf('1', 'Позичена книга'),
}

/** A fact the owner recorded for a guest: the API sends it without names, contact or loan id. */
const LENT_TO_GUEST: MyHistoryEntry = {
  entry: {
    names: false,
    status: 'HANDED_OVER',
    isOverdue: false,
    origin: 'RECORDED_GUEST',
    guestEvidence: 'OWNER_STATEMENT',
    requestedAt: null,
    respondedAt: null,
    handedAt: '2026-03-01T00:00:00.000Z',
    returnedAt: null,
    dueAt: null,
  },
  copy: copyOf('2', 'Книга в гостя'),
}

const HISTORY: MyHistoryResponse = { borrowed: [BORROWED], lent: [] }

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue(HISTORY)
  mockReplace.mockReset()
  mockParameters = new URLSearchParams('tab=history')
})

const historyTablist = () => screen.getByRole('tablist', { name: 'Вигляд історії' })

describe('LoansScreen ?tab=history: «Що я брав» / «Що в мене брали» (BS-88, BS-143)', () => {
  it('відкривається на «Історії» → «Що я брав», і вкладка керує панеллю зі списком', async () => {
    render(<LoansScreen />)

    const borrowed = screen.getByRole('tab', { name: 'Що я брав' })

    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveAttribute('aria-selected', 'true')
    expect(
      within(historyTablist())
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Що я брав', 'Що в мене брали'])
    expect(borrowed).toHaveAttribute('aria-selected', 'true')
    expect(document.getElementById(borrowed.getAttribute('aria-controls') ?? '')).toHaveAttribute(
      'role',
      'tabpanel',
    )
    expect(await screen.findByRole('link', { name: 'Позичена книга' })).toBeVisible()
    expect(requestedPaths()).toEqual(['/me/history'])
  })

  it('зовнішній і вкладений список вкладок мають різні назви', async () => {
    render(<LoansScreen />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    expect(screen.getAllByRole('tablist').map((list) => list.getAttribute('aria-label'))).toEqual([
      'Вкладки позичань',
      'Вигляд історії',
    ])
  })

  it('картка зберігає дати, імена сторін, посилання на твір і на історію примірника', async () => {
    render(<LoansScreen />)

    const card = (await screen.findByRole('link', { name: 'Позичена книга' })).closest('li')

    expect(card).not.toBeNull()
    const inCard = within(card as HTMLElement)

    expect(inCard.getByRole('link', { name: 'Позичена книга' })).toHaveAttribute(
      'href',
      '/works/work-1',
    )
    expect(inCard.getByRole('link', { name: 'Уся історія примірника' })).toHaveAttribute(
      'href',
      '/copies/copy-1/history',
    )
    expect(card).toHaveTextContent('Я у Марта')
    expect(card).toHaveTextContent(/Попросили .*передали .*повернули/)
  })

  it('«Що в мене брали» пишеться в адресу через replace і зберігає решту параметрів', async () => {
    mockParameters = new URLSearchParams('tab=history&role=borrower')

    render(<LoansScreen />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    await userEvent.click(screen.getByRole('tab', { name: 'Що в мене брали' }))

    expect(mockReplace).toHaveBeenCalledWith('/loans?tab=history&role=borrower&historyView=lent')
  })

  it('нова адреса показує «Що в мене брали» з порожнім станом без нового запиту', async () => {
    const { rerender } = render(<LoansScreen />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    mockParameters = new URLSearchParams('tab=history&historyView=lent')
    rerender(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Що в мене брали' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('У вас поки нічого не брали.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Позичена книга' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('пряме відкриття / перезавантаження ?tab=history&historyView=lent одразу на «Що в мене брали»', async () => {
    mockParameters = new URLSearchParams('tab=history&historyView=lent')
    apiRequest.mockResolvedValue({ borrowed: [BORROWED], lent: [LENT_TO_GUEST] })

    render(<LoansScreen />)

    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Що в мене брали' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(await screen.findByRole('link', { name: 'Книга в гостя' })).toBeVisible()
  })

  it('гостьовий запис лишається анонімним: «у когось», без імен, alias чи контакту', async () => {
    mockParameters = new URLSearchParams('tab=history&historyView=lent')
    apiRequest.mockResolvedValue({ borrowed: [], lent: [LENT_TO_GUEST] })

    render(<LoansScreen />)

    const card = (await screen.findByRole('link', { name: 'Книга в гостя' })).closest('li')

    expect(card).toHaveTextContent('у когось')
    expect(card).toHaveTextContent('Записано власником')
    expect(card).not.toHaveTextContent(/Я у|гість:|контакт/i)
    expect(
      within(card as HTMLElement).getByRole('link', { name: 'Уся історія примірника' }),
    ).toHaveAttribute('href', '/copies/copy-2/history')
  })

  it.each([
    ['borrowed', 'Ви поки нічого не брали.'],
    ['lent', 'У вас поки нічого не брали.'],
  ])('порожня історія: «%s» має свій зрозумілий текст', async (view, text) => {
    mockParameters = new URLSearchParams(`tab=history&historyView=${view}`)
    apiRequest.mockResolvedValue({ borrowed: [], lent: [] })

    render(<LoansScreen />)

    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  })

  it.each(['borrowed', 'lent'])('«%s»: поки історія вантажиться — стан завантаження', (view) => {
    mockParameters = new URLSearchParams(`tab=history&historyView=${view}`)
    apiRequest.mockReturnValue(new Promise(() => undefined))

    render(<LoansScreen />)

    expect(
      within(screen.getAllByRole('tabpanel').at(-1) as HTMLElement).getByText('Завантажую…'),
    ).toBeVisible()
  })

  it.each(['borrowed', 'lent'])('«%s»: помилка завантаження показується в панелі', async (view) => {
    mockParameters = new URLSearchParams(`tab=history&historyView=${view}`)
    apiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )

    render(<LoansScreen />)

    expect(await screen.findByText(/Сервер недоступний/)).toBeVisible()
    expect(screen.queryByText(/поки нічого не брали/)).not.toBeInTheDocument()
  })

  it('історія не читає списку поточних позичань, а списки позичань — історії', async () => {
    render(<LoansScreen />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    expect(requestedPaths()).toEqual(['/me/history'])
    expect(screen.queryByLabelText('Статус')).not.toBeInTheDocument()
  })

  it('перемикається з клавіатури: навігація розділу → «Історія» → «Що я брав» → стрілка → Enter', async () => {
    const user = userEvent.setup()

    render(<LoansScreen />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    // The section navigation stands above the tabs: three links, each its own Tab stop.
    for (const name of ['Книжки', 'Позичання', 'Вішлист']) {
      await user.tab()
      expect(screen.getByRole('link', { name })).toHaveFocus()
    }

    await user.tab()
    expect(screen.getByRole('tab', { name: 'Історія' })).toHaveFocus()

    // The open outer panel is its own Tab stop; the nested tablist comes right inside it.
    await user.tab()
    await user.tab()
    expect(screen.getByRole('tab', { name: 'Що я брав' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Що в мене брали' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(mockReplace).toHaveBeenCalledWith('/loans?tab=history&historyView=lent')
  })
})
