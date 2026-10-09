/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { MyHistoryEntry, MyHistoryResponse } from '@bookswap/shared'
import type { SessionState } from '@/app/lib/use-session'
import HistoryPage from './page'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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
    handedAt: null,
    returnedAt: null,
    dueAt: null,
  },
  copy: {
    id: 'copy-1',
    status: 'AVAILABLE',
    condition: 'GOOD',
    edition: {
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
    },
    work: {
      id: 'work-1',
      title: 'Позичена книга',
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [],
  },
}

const HISTORY: MyHistoryResponse = { borrowed: [BORROWED], lent: [] }

beforeEach(() => {
  apiRequest.mockReset()
  apiRequest.mockResolvedValue(HISTORY)
})

describe('HistoryPage: вкладки «Що я брав» / «Що в мене брали» (BS-88)', () => {
  it('відкривається на «Що я брав», і вкладка керує панеллю зі списком', async () => {
    render(<HistoryPage />)

    const borrowed = screen.getByRole('tab', { name: 'Що я брав' })

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Що я брав',
      'Що в мене брали',
    ])
    expect(borrowed).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'id',
      borrowed.getAttribute('aria-controls'),
    )
    expect(await screen.findByRole('link', { name: 'Позичена книга' })).toBeVisible()
  })

  it('«Що в мене брали» показує свій порожній стан без нового запиту', async () => {
    render(<HistoryPage />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    await userEvent.click(screen.getByRole('tab', { name: 'Що в мене брали' }))

    expect(screen.getByRole('tab', { name: 'Що в мене брали' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByText('У вас поки нічого не брали.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Позичена книга' })).not.toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('перемикається з клавіатури: стрілка переводить фокус, Enter обирає вкладку', async () => {
    const user = userEvent.setup()

    render(<HistoryPage />)
    await screen.findByRole('link', { name: 'Позичена книга' })

    await user.tab()
    expect(screen.getByRole('tab', { name: 'Що я брав' })).toHaveFocus()

    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: 'Що в мене брали' })).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(screen.getByText('У вас поки нічого не брали.')).toBeVisible()
  })
})
