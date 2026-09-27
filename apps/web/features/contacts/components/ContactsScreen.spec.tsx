/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { ContactsScreen } from './ContactsScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const contact = (id: string, alias: string) => ({
  id,
  alias,
  ownerInformedAt: '2026-09-27T10:00:00.000Z',
  createdAt: '2026-09-27T10:00:00.000Z',
})

let stored: ReturnType<typeof contact>[] = []

beforeEach(() => {
  jest.clearAllMocks()
  stored = []
  apiRequest.mockImplementation(
    (path: string, options?: { method?: string; body?: { alias: string } }) => {
      if (path === '/me/external-borrowers' && options?.method === 'POST') {
        const created = contact('c-new', options.body?.alias ?? '')

        stored = [created, ...stored]

        return Promise.resolve({ contact: created })
      }

      if (path === '/me/external-borrowers') return Promise.resolve({ contacts: stored })

      if (options?.method === 'PATCH') {
        const id = decodeURIComponent(path.split('/').pop() ?? '')

        return Promise.resolve({ contact: contact(id, options.body?.alias ?? '') })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    },
  )
})

describe('ContactsScreen', () => {
  it('shows the synthetic-data banner and a loading state first', async () => {
    apiRequest.mockImplementation(() => new Promise(() => undefined))
    render(<ContactsScreen />)

    expect(screen.getByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
    expect(screen.getByText('Завантажую контакти…')).toBeInTheDocument()
  })

  it('while the list is loading there is no create form and no POST; the late GET then shows the form', async () => {
    let finish: (value: { contacts: [] }) => void = () => undefined

    apiRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<ContactsScreen />)

    expect(screen.getByText('Завантажую контакти…')).toBeInTheDocument()
    expect(screen.queryByLabelText('Аліас')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Додати контакт' })).not.toBeInTheDocument()

    finish({ contacts: [] })

    expect(await screen.findByRole('button', { name: 'Додати контакт' })).toBeInTheDocument()
    expect(apiRequest.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      0,
    )
  })

  it('a created contact is in the list at once, with the success message', async () => {
    let finish: (value: { contacts: [] }) => void = () => undefined

    apiRequest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    render(<ContactsScreen />)
    finish({ contacts: [] })

    await userEvent.type(await screen.findByLabelText('Аліас'), 'Гість')
    await userEvent.click(screen.getByLabelText('Я повідомив(-ла) людину'))
    await userEvent.click(screen.getByRole('button', { name: 'Додати контакт' }))

    expect(await screen.findByText('Контакт додано.')).toBeInTheDocument()
    expect(screen.getByRole('list')).toHaveTextContent('Гість')
    expect(screen.queryByText('Контактів поки немає.')).not.toBeInTheDocument()
  })

  it('empty state', async () => {
    render(<ContactsScreen />)

    expect(await screen.findByText('Контактів поки немає.')).toBeInTheDocument()
  })

  it('error state with retry', async () => {
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'Збій сервера' }),
    )
    render(<ContactsScreen />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Збій сервера')
    expect(screen.queryByLabelText('Аліас')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Додати контакт' })).not.toBeInTheDocument()

    stored = [contact('c-1', 'Тестовий')]
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('Тестовий')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати контакт' })).toBeInTheDocument()
  })

  it('does not call the API and shows an error when the owner has not made the statement', async () => {
    render(<ContactsScreen />)
    await screen.findByText('Контактів поки немає.')

    await userEvent.type(screen.getByLabelText('Аліас'), 'Гість')
    await userEvent.click(screen.getByRole('button', { name: 'Додати контакт' }))

    expect(await screen.findByText('Потрібна заява власника')).toBeInTheDocument()
    expect(apiRequest.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      0,
    )
  })

  it('does not call the API for an empty alias', async () => {
    render(<ContactsScreen />)
    await screen.findByText('Контактів поки немає.')

    await userEvent.click(screen.getByLabelText('Я повідомив(-ла) людину'))
    await userEvent.click(screen.getByRole('button', { name: 'Додати контакт' }))

    expect(await screen.findByText('Вкажіть аліас')).toBeInTheDocument()
    expect(apiRequest.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      0,
    )
  })

  it('creates a contact with exactly alias + ownerInformed and shows success', async () => {
    render(<ContactsScreen />)
    await screen.findByText('Контактів поки немає.')

    await userEvent.type(screen.getByLabelText('Аліас'), '  Гість ')
    await userEvent.click(screen.getByLabelText('Я повідомив(-ла) людину'))
    await userEvent.click(screen.getByRole('button', { name: 'Додати контакт' }))

    expect(await screen.findByText('Контакт додано.')).toBeInTheDocument()
    expect(screen.getByText('Гість')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith('/me/external-borrowers', {
      method: 'POST',
      body: { alias: 'Гість', ownerInformed: true },
      schema: expect.anything(),
    })
  })

  it('shows a server error on create and keeps the form', async () => {
    render(<ContactsScreen />)
    await screen.findByText('Контактів поки немає.')
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(400, { code: 'VALIDATION_ERROR', message: 'Помилка валідації' }),
    )

    await userEvent.type(screen.getByLabelText('Аліас'), 'Гість')
    await userEvent.click(screen.getByLabelText('Я повідомив(-ла) людину'))
    await userEvent.click(screen.getByRole('button', { name: 'Додати контакт' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Помилка валідації')
    expect(screen.getByLabelText('Аліас')).toHaveValue('Гість')
  })

  it('renames only the alias', async () => {
    stored = [contact('c-1', 'Старий')]
    render(<ContactsScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Змінити аліас' }))

    const field = screen.getByLabelText('Новий аліас')

    await userEvent.clear(field)
    await userEvent.type(field, 'Новий')
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Аліас змінено.')).toBeInTheDocument()
    expect(screen.getByText('Новий')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith('/me/external-borrowers/c-1', {
      method: 'PATCH',
      body: { alias: 'Новий' },
      schema: expect.anything(),
    })
  })

  it('rejects an empty new alias locally and shows a server error on rename', async () => {
    stored = [contact('c-1', 'Старий')]
    render(<ContactsScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Змінити аліас' }))
    await userEvent.clear(screen.getByLabelText('Новий аліас'))
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Вкажіть аліас')).toBeInTheDocument()
    expect(apiRequest.mock.calls.filter(([, options]) => options?.method === 'PATCH')).toHaveLength(
      0,
    )

    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Контакт не знайдено' }),
    )
    await userEvent.type(screen.getByLabelText('Новий аліас'), 'Інший')
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Контакт не знайдено')
    })
  })

  it('never calls the owner statement a consent', async () => {
    const { container } = render(<ContactsScreen />)

    await screen.findByText('Контактів поки немає.')
    expect(container.textContent.toLowerCase()).not.toMatch(/згод/)
    expect(screen.getByText(/не є підтвердженням з боку самої людини/)).toBeInTheDocument()
  })
})
