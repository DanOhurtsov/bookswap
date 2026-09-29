/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
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
  guestNickname: null as string | null,
  guestEmail: null as string | null,
  guestEmailVerifiedAt: null as string | null,
})

let stored: ReturnType<typeof contact>[] = []

/** jsdom has no `showModal`; the delete confirmation is a native `<dialog>`. */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

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

      if (options?.method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop() ?? '')

        stored = stored.filter((item) => item.id !== id)

        return Promise.resolve(undefined)
      }

      if (options?.method === 'POST' && path.endsWith('/invitation')) {
        return Promise.resolve({
          invitation: {
            id: 'inv-1',
            kind: 'EMAIL',
            status: 'ACTIVE',
            expiresAt: '2026-10-11T00:00:00.000Z',
            createdAt: '2026-09-27T00:00:00.000Z',
            acceptedCount: 0,
            maxUses: 1,
          },
        })
      }

      return Promise.reject(new Error(`unexpected ${path}`))
    },
  )
})

describe('ContactsScreen', () => {
  it('10i.3: confirmed guest nickname/email are shown to the owner only in the contact, alias untouched; absent when not confirmed', async () => {
    stored = [
      {
        ...contact('c-confirmed', 'Мій Псевдонім'),
        guestNickname: 'Нік Гостя',
        guestEmail: 'guest-b@guest.invalid',
        guestEmailVerifiedAt: '2026-09-29T10:00:00.000Z',
      },
      contact('c-plain', 'Без відповіді'),
    ]
    render(<ContactsScreen />)

    const details = await screen.findByTestId('contact-guest-details')

    expect(details).toHaveTextContent('Нік Гостя')
    expect(details).toHaveTextContent('guest-b@guest.invalid')
    expect(screen.getByText('Мій Псевдонім')).toBeInTheDocument()
    // Контакт без підтвердженої відповіді нічого не показує.
    expect(screen.getAllByTestId('contact-guest-details')).toHaveLength(1)
  })

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

  it('delete: confirm dialog, then a 204 removes the contact from the list', async () => {
    stored = [contact('c-1', 'Гість')]
    render(<ContactsScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Видалити' }))

    const dialog = await screen.findByRole('alertdialog')

    expect(dialog).toHaveTextContent('Видалити контакт?')
    // Не видаляємо одразу по кліку на "Видалити" в рядку — лише після підтвердження в діалозі.
    expect(screen.getByText('Гість')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }))

    await waitFor(() => {
      expect(apiRequest).toHaveBeenCalledWith('/me/external-borrowers/c-1', { method: 'DELETE' })
    })
    await waitFor(() => {
      expect(screen.queryByText('Гість')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Контактів поки немає.')).toBeInTheDocument()
  })

  it('delete: 409 active-loan/unresolved-loss keeps the contact and shows the server message', async () => {
    stored = [contact('c-1', 'Гість')]
    render(<ContactsScreen />)

    apiRequest.mockImplementationOnce(() =>
      Promise.reject(
        new ApiRequestError(409, {
          code: 'EXTERNAL_BORROWER_HAS_ACTIVE_LOAN',
          message: 'У контакта є активна гостьова позика',
        }),
      ),
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Видалити' }))
    const dialog = await screen.findByRole('alertdialog')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Видалити' }))

    expect(await screen.findByText('У контакта є активна гостьова позика')).toBeInTheDocument()
    expect(screen.getByText('Гість')).toBeInTheDocument()
  })

  it('delete: cancel keeps the contact and sends no request', async () => {
    stored = [contact('c-1', 'Гість')]
    render(<ContactsScreen />)

    await userEvent.click(await screen.findByRole('button', { name: 'Видалити' }))
    const dialog = await screen.findByRole('alertdialog')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))

    expect(
      apiRequest.mock.calls.filter(([, options]) => options?.method === 'DELETE'),
    ).toHaveLength(0)
    expect(screen.getByText('Гість')).toBeInTheDocument()
  })

  it('never calls the owner statement a consent', async () => {
    const { container } = render(<ContactsScreen />)

    await screen.findByText('Контактів поки немає.')
    expect(container.textContent.toLowerCase()).not.toMatch(/згод/)
    expect(screen.getByText(/не є підтвердженням з боку самої людини/)).toBeInTheDocument()
  })

  describe('запрошення гостя (10g)', () => {
    async function openInviteForm(): Promise<void> {
      stored = [contact('c-1', 'Гість')]
      render(<ContactsScreen />)
      await userEvent.click(await screen.findByRole('button', { name: 'Запросити гостя' }))
    }

    it('form is closed by default; opening it does not call the API', async () => {
      stored = [contact('c-1', 'Гість')]
      render(<ContactsScreen />)

      await screen.findByText('Гість')
      expect(screen.queryByLabelText('Email гостя')).not.toBeInTheDocument()

      await userEvent.click(screen.getByRole('button', { name: 'Запросити гостя' }))

      expect(await screen.findByLabelText('Email гостя')).toBeInTheDocument()
      expect(
        apiRequest.mock.calls.filter(
          ([path, options]) => options?.method === 'POST' && path.endsWith('/invitation'),
        ),
      ).toHaveLength(0)
    })

    it('rejects a non-synthetic domain locally, without calling the API', async () => {
      await openInviteForm()

      await userEvent.type(screen.getByLabelText('Email гостя'), 'guest@example.com')
      await userEvent.click(screen.getByRole('button', { name: 'Надіслати запрошення' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('guest.invalid')
      expect(
        apiRequest.mock.calls.filter(
          ([path, options]) => options?.method === 'POST' && path.endsWith('/invitation'),
        ),
      ).toHaveLength(0)
    })

    it('sends exactly { email } to the contact-scoped route, shows success and clears the field', async () => {
      await openInviteForm()

      await userEvent.type(screen.getByLabelText('Email гостя'), 'guest@guest.invalid')
      await userEvent.click(screen.getByRole('button', { name: 'Надіслати запрошення' }))

      expect(await screen.findByText(/Створено тестове запрошення/)).toBeInTheDocument()
      expect(apiRequest).toHaveBeenCalledWith('/me/external-borrowers/c-1/invitation', {
        method: 'POST',
        body: { email: 'guest@guest.invalid' },
        schema: expect.anything(),
      })
      // Q4/UI: адреса не лишається в стані сторінки після результату.
      expect(screen.getByLabelText('Email гостя')).toHaveValue('')
    })

    it('blocks a second submit while the first is pending', async () => {
      stored = [contact('c-1', 'Гість')]
      render(<ContactsScreen />)
      await userEvent.click(await screen.findByRole('button', { name: 'Запросити гостя' }))

      let finish: (value: unknown) => void = () => undefined

      apiRequest.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )

      await userEvent.type(screen.getByLabelText('Email гостя'), 'guest@guest.invalid')

      const submit = screen.getByRole('button', { name: /Надсилаю|Надіслати запрошення/ })

      await userEvent.click(submit)
      await userEvent.click(submit)

      expect(
        apiRequest.mock.calls.filter(
          ([path, options]) => options?.method === 'POST' && path.endsWith('/invitation'),
        ),
      ).toHaveLength(1)

      finish({
        invitation: {
          id: 'inv-1',
          kind: 'EMAIL',
          status: 'ACTIVE',
          expiresAt: '2026-10-11T00:00:00.000Z',
          createdAt: '2026-09-27T00:00:00.000Z',
          acceptedCount: 0,
          maxUses: 1,
        },
      })
      expect(await screen.findByText(/Створено тестове запрошення/)).toBeInTheDocument()
    })

    it('shows a server error and clears the field; the API never echoes the address back', async () => {
      await openInviteForm()
      apiRequest.mockImplementationOnce((path: string, options?: { method?: string }) =>
        path.endsWith('/invitation') && options?.method === 'POST'
          ? Promise.reject(
              new ApiRequestError(429, {
                code: 'INVITE_RATE_LIMITED',
                message: 'Забагато запрошень поштою. Спробуйте пізніше або поділіться посиланням.',
              }),
            )
          : Promise.reject(new Error('unexpected call')),
      )

      await userEvent.type(screen.getByLabelText('Email гостя'), 'guest@guest.invalid')
      await userEvent.click(screen.getByRole('button', { name: 'Надіслати запрошення' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Забагато запрошень поштою')
      expect(screen.getByLabelText('Email гостя')).toHaveValue('')
    })

    it('hiding the form clears any typed address', async () => {
      await openInviteForm()

      await userEvent.type(screen.getByLabelText('Email гостя'), 'guest@guest.invalid')
      await userEvent.click(screen.getByRole('button', { name: 'Сховати' }))
      await userEvent.click(screen.getByRole('button', { name: 'Запросити гостя' }))

      expect(screen.getByLabelText('Email гостя')).toHaveValue('')
    })
  })
})
