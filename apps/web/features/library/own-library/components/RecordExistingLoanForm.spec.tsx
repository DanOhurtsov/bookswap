/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { RecordExistingLoanForm } from './RecordExistingLoanForm'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const FRIEND = {
  user: { id: 'friend-1', displayName: 'Олесь', avatarUrl: null },
  friendsSince: '2026-01-01T00:00:00.000Z',
}

function mockFriends(friends: unknown[]) {
  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/friends') return Promise.resolve({ friends })
    if (path === '/friends/requests') return Promise.resolve({ incoming: [], outgoing: [] })

    return Promise.resolve({ loan: {} })
  })
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

function setup() {
  const onRecorded = jest.fn().mockResolvedValue(undefined)
  const onCancel = jest.fn()

  render(<RecordExistingLoanForm copyId="copy-1" onRecorded={onRecorded} onCancel={onCancel} />)

  return { onRecorded, onCancel }
}

describe('RecordExistingLoanForm (Stage 10, 10e)', () => {
  it('loading: поки друзі вантажаться, показує статус', () => {
    mockApiRequest.mockReturnValue(new Promise(() => undefined))
    setup()

    expect(screen.getByText('Завантажую друзів…')).toBeInTheDocument()
  })

  it('error: помилка завантаження друзів і можливість скасувати', async () => {
    mockApiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }),
    )

    const { onCancel } = setup()

    expect(await screen.findByText(/Збій/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(onCancel).toHaveBeenCalled()
  })

  it('empty: без друзів пояснює, що записати можна лише другові', async () => {
    mockFriends([])
    setup()

    expect(await screen.findByText(/лише другові/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'додайте друга' })).toHaveAttribute('href', '/friends')
    expect(screen.queryByRole('button', { name: 'Записати передачу' })).not.toBeInTheDocument()
  })

  it('пояснює, що це запис власника і що до відповіді книжка недоступна іншим', async () => {
    mockFriends([FRIEND])
    setup()

    expect(await screen.findByText(/недоступна іншим/)).toBeInTheDocument()
    expect(screen.getByLabelText('Коли віддали')).toHaveAttribute(
      'max',
      new Date().toISOString().slice(0, 10),
    )
  })

  it('валідація: без друга й дати запит не надсилається', async () => {
    mockFriends([FRIEND])
    setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Записати передачу' }))

    expect(mockApiRequest).not.toHaveBeenCalledWith('/loans/recorded', expect.anything())
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
  })

  it('success: POST /loans/recorded з обраним другом і датами, потім onRecorded', async () => {
    mockFriends([FRIEND])

    const { onRecorded } = setup()

    await userEvent.selectOptions(await screen.findByLabelText('Кому віддали'), 'friend-1')
    await userEvent.type(screen.getByLabelText('Коли віддали'), '2026-09-01')
    await userEvent.type(screen.getByLabelText('Повернути до'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Записати передачу' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/loans/recorded',
        expect.objectContaining({
          method: 'POST',
          body: {
            copyId: 'copy-1',
            borrowerId: 'friend-1',
            handedAt: '2026-09-01',
            dueAt: '2026-10-01',
          },
        }),
      )
    })
    await waitFor(() => {
      expect(onRecorded).toHaveBeenCalled()
    })
  })

  it('error: відмова API показується, форма лишається для повтору', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path === '/friends') return Promise.resolve({ friends: [FRIEND] })
      if (path === '/friends/requests') return Promise.resolve({ incoming: [], outgoing: [] })

      return Promise.reject(
        new ApiRequestError(409, {
          code: 'LOAN_COPY_UNAVAILABLE',
          message: 'Примірник не вільний',
        }),
      )
    })

    const { onRecorded } = setup()

    await userEvent.selectOptions(await screen.findByLabelText('Кому віддали'), 'friend-1')
    await userEvent.type(screen.getByLabelText('Коли віддали'), '2026-09-01')
    await userEvent.click(screen.getByRole('button', { name: 'Записати передачу' }))

    expect(await screen.findByText('Примірник не вільний')).toBeInTheDocument()
    expect(onRecorded).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Записати передачу' })).toBeEnabled()
  })
})
