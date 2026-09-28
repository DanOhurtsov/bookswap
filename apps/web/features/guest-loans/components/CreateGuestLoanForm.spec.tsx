/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { CreateGuestLoanForm } from './CreateGuestLoanForm'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const CONTACT = {
  id: 'contact-1',
  alias: 'Синтетичний Гість',
  ownerInformedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
}

function mockContacts(contacts: unknown[]) {
  mockApiRequest.mockImplementation((path: string) => {
    if (path === '/me/external-borrowers') return Promise.resolve({ contacts })

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

function setup() {
  const onCreated = jest.fn().mockResolvedValue(undefined)
  const onCancel = jest.fn()

  render(<CreateGuestLoanForm copyId="copy-1" onCreated={onCreated} onCancel={onCancel} />)

  return { onCreated, onCancel }
}

describe('CreateGuestLoanForm (Stage 10, 10f.3)', () => {
  it('loading: поки контакти вантажаться, показує статус', () => {
    mockApiRequest.mockReturnValue(new Promise(() => undefined))
    setup()

    expect(screen.getByText('Завантажую контакти…')).toBeInTheDocument()
  })

  it('error: помилка завантаження контактів і можливість скасувати', async () => {
    mockApiRequest.mockRejectedValue(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }),
    )

    const { onCancel } = setup()

    expect(await screen.findByText(/Збій/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(onCancel).toHaveBeenCalled()
  })

  it('empty: без контактів пояснює, що позичити гостю можна лише за наявним контактом', async () => {
    mockContacts([])
    setup()

    expect(await screen.findByText(/лише за наявним контактом/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'додайте контакт' })).toHaveAttribute(
      'href',
      '/contacts',
    )
    expect(
      screen.queryByRole('button', { name: 'Записати гостьову позику' }),
    ).not.toBeInTheDocument()
  })

  it('показує банер про синтетичні дані й попередження про відсутність підтвердження гостя', async () => {
    mockContacts([CONTACT])
    setup()

    expect(await screen.findByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
    expect(screen.getByText(/підтвердження від неї не буде/)).toBeInTheDocument()
    expect(screen.getByLabelText('Коли віддали')).toHaveAttribute(
      'max',
      new Date().toISOString().slice(0, 10),
    )
  })

  it('валідація: без контакту й дати запит не надсилається', async () => {
    mockContacts([CONTACT])
    setup()
    await userEvent.click(await screen.findByRole('button', { name: 'Записати гостьову позику' }))

    expect(mockApiRequest).not.toHaveBeenCalledWith('/loans/guest', expect.anything())
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
  })

  it('success: POST /loans/guest з обраним контактом і датами, потім onCreated', async () => {
    mockApiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === '/me/external-borrowers') return Promise.resolve({ contacts: [CONTACT] })
      if (path === '/loans/guest' && options?.method === 'POST') {
        return Promise.resolve({ loan: { id: 'loan-1' } })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    })

    const { onCreated } = setup()

    await userEvent.selectOptions(await screen.findByLabelText('Кому віддали'), 'contact-1')
    await userEvent.type(screen.getByLabelText('Коли віддали'), '2026-09-01')
    await userEvent.type(screen.getByLabelText('Повернути до'), '2026-10-01')
    await userEvent.click(screen.getByRole('button', { name: 'Записати гостьову позику' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/loans/guest',
        expect.objectContaining({
          method: 'POST',
          body: {
            copyId: 'copy-1',
            externalBorrowerId: 'contact-1',
            handedAt: '2026-09-01',
            dueAt: '2026-10-01',
          },
        }),
      )
    })
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalled()
    })
  })

  it('error: відмова API показується, форма лишається для повтору (захист від повторного submit знімається)', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path === '/me/external-borrowers') return Promise.resolve({ contacts: [CONTACT] })

      return Promise.reject(
        new ApiRequestError(409, {
          code: 'LOAN_COPY_UNAVAILABLE',
          message: 'Примірник не вільний',
        }),
      )
    })

    const { onCreated } = setup()

    await userEvent.selectOptions(await screen.findByLabelText('Кому віддали'), 'contact-1')
    await userEvent.type(screen.getByLabelText('Коли віддали'), '2026-09-01')
    await userEvent.click(screen.getByRole('button', { name: 'Записати гостьову позику' }))

    expect(await screen.findByText('Примірник не вільний')).toBeInTheDocument()
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Записати гостьову позику' })).toBeEnabled()
  })

  it('cancel викликає onCancel', async () => {
    mockContacts([CONTACT])
    const { onCancel } = setup()

    await userEvent.click(await screen.findByRole('button', { name: 'Скасувати' }))

    expect(onCancel).toHaveBeenCalled()
  })

  it('приватність: жоден запит контактів не несе alias у тілі створення (лише id)', async () => {
    mockContacts([CONTACT])
    setup()

    await userEvent.selectOptions(await screen.findByLabelText('Кому віддали'), 'contact-1')
    await userEvent.type(screen.getByLabelText('Коли віддали'), '2026-09-01')
    await userEvent.click(screen.getByRole('button', { name: 'Записати гостьову позику' }))

    await waitFor(() => {
      const createCall = mockApiRequest.mock.calls.find(([path]) => path === '/loans/guest')

      expect(createCall).toBeDefined()
      expect(JSON.stringify(createCall?.[1]?.body ?? {})).not.toContain('alias')
    })
  })
})
