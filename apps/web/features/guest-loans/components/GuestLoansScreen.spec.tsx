/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GuestLoan } from '@bookswap/shared'
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

const LOAN: GuestLoan = {
  id: 'loan-1',
  status: 'HANDED_OVER',
  isOverdue: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  handedAt: '2026-01-01T00:00:00.000Z',
  returnedAt: null,
  dueAt: null,
  copy: { id: 'copy-1', status: 'LENT_OUT', condition: 'GOOD', isArchived: false },
  edition: {
    id: 'ed-1',
    workId: 'work-1',
    translationId: null,
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
    title: 'Тестова книга',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  contact: { id: 'contact-1', alias: 'Синтетичний Гість' },
  recovery: null,
  lossClosure: null,
}

/** jsdom has no `showModal`; the mark_lost confirmation is a native `<dialog>`. */
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

describe('GuestLoansScreen (Stage 10, 10f.3)', () => {
  it('loading: показує статус, поки список вантажиться', () => {
    mockApiRequest.mockReturnValue(new Promise(() => undefined))
    render(<GuestLoansScreen />)

    expect(screen.getByText('Завантажую…')).toBeInTheDocument()
  })

  it('empty: пояснює, де записати гостьову позику', async () => {
    mockApiRequest.mockResolvedValue({ loans: [] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText(/Гостьових позик поки немає/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'бібліотеці' })).toHaveAttribute('href', '/library')
  })

  it('error: показує повідомлення сервера', async () => {
    mockApiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }),
    )
    render(<GuestLoansScreen />)

    expect(await screen.findByText(/Збій/)).toBeInTheDocument()
  })

  it('ready: список показує книжку, гостя й попередження про синтетичні дані', async () => {
    mockApiRequest.mockResolvedValue({ loans: [LOAN] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(screen.getByText(/Синтетичний Гість/)).toBeInTheDocument()
    expect(screen.getByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
  })

  it('приватність: контакт видалено — показує «контакт видалено», а не старий alias', async () => {
    mockApiRequest.mockResolvedValue({ loans: [{ ...LOAN, contact: null }] })
    render(<GuestLoansScreen />)

    expect(await screen.findByText(/контакт видалено/)).toBeInTheDocument()
  })

  it('?loanId=: показує одну позику через GET /loans/guest/:id', async () => {
    parameters = new URLSearchParams('loanId=loan-1')
    mockApiRequest.mockImplementation((path: string) => {
      if (path === '/loans/guest/loan-1') return Promise.resolve({ loan: LOAN })

      return Promise.reject(new Error(`unexpected ${path}`))
    })

    render(<GuestLoansScreen />)

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(screen.getByText('Показати всі')).toBeInTheDocument()
  })

  it('дія «Повернуто»: PATCH, потім оновлення списку', async () => {
    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/loans/guest' && options?.method === undefined) {
        return Promise.resolve({ loans: [LOAN] })
      }
      if (path === '/loans/guest/loan-1' && options?.method === 'PATCH') {
        return Promise.resolve({
          loan: { ...LOAN, status: 'RETURNED', returnedAt: '2026-02-01T00:00:00.000Z' },
        })
      }

      return Promise.reject(new Error(`unexpected ${path} ${options?.method ?? 'GET'}`))
    })

    render(<GuestLoansScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Повернуто' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/loans/guest/loan-1',
        expect.objectContaining({ method: 'PATCH', body: { action: 'return' } }),
      )
    })
    // Item 5 (10f.3 web-рев'ю): дані оновлюються після дії — щонайменше два GET списку (перше
    // завантаження і оновлення після дії).
    await waitFor(() => {
      const listCalls = mockApiRequest.mock.calls.filter(([path]) => path === '/loans/guest')
      expect(listCalls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('409 на дію: показує помилку сервера і все одно перечитує дані (свіжа картка одразу)', async () => {
    let listCallCount = 0

    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/loans/guest' && options?.method === undefined) {
        listCallCount += 1
        return Promise.resolve({ loans: [LOAN] })
      }
      if (path === '/loans/guest/loan-1' && options?.method === 'PATCH') {
        return Promise.reject(
          new ApiRequestError(409, { code: 'LOAN_ALREADY_CLOSED', message: 'Уже повернено' }),
        )
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    })

    render(<GuestLoansScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Повернуто' }))

    expect(await screen.findByText('Уже повернено')).toBeInTheDocument()
    await waitFor(() => {
      expect(listCallCount).toBeGreaterThanOrEqual(2)
    })
  })

  it('дія «Втрачено» після підтвердження: PATCH з action mark_lost', async () => {
    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/loans/guest' && options?.method === undefined) {
        return Promise.resolve({ loans: [LOAN] })
      }
      if (path === '/loans/guest/loan-1' && options?.method === 'PATCH') {
        return Promise.resolve({ loan: { ...LOAN, status: 'LOST' } })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    })

    render(<GuestLoansScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Втрачено' }))

    const dialog = await screen.findByRole('alertdialog')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Втрачено' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/loans/guest/loan-1',
        expect.objectContaining({ method: 'PATCH', body: { action: 'mark_lost' } }),
      )
    })
  })
})
