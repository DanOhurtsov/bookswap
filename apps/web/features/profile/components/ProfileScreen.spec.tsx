/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Me, UpdateProfileRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { ProfileScreen } from './ProfileScreen'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

interface RequestOptions {
  method?: string
  body?: UpdateProfileRequest
}

const saved: Me = {
  id: 'user-1',
  email: 'marta@example.com',
  emailVerified: true,
  displayName: 'Марта',
  avatarUrl: 'https://img.example/marta.png',
  bio: 'Читаю фантастику',
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

let stored: Me
/** Replaces the default PATCH answer; the default stores the body like the API does. */
let patchAnswer: ((body: UpdateProfileRequest) => Promise<Me>) | undefined

/** A tiny in-memory server: the session reads what the last successful PATCH stored. */
function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === '/auth/session') {
      return Promise.resolve({ user: stored, features: { guestLoans: false } })
    }

    if (path === '/me' && options.method === 'PATCH' && options.body !== undefined) {
      if (patchAnswer !== undefined) return patchAnswer(options.body)

      stored = { ...stored, ...options.body }

      return Promise.resolve(stored)
    }

    if (path === '/auth/email-verification' && options.method === 'POST') {
      return Promise.resolve({ accepted: true })
    }

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function patches(): RequestOptions[] {
  return apiRequest.mock.calls
    .filter(([path, options]) => path === '/me' && (options as RequestOptions).method === 'PATCH')
    .map(([, options]) => options as RequestOptions)
}

/** What the rest of the app sees: the session user, outside the profile screen. */
function SessionProbe() {
  const { state } = useSession()

  return (
    <output aria-label="Користувач сесії">
      {state.status === 'authenticated' ? state.user.displayName : state.status}
    </output>
  )
}

function renderProfile() {
  return render(
    <SessionProvider>
      <SessionProbe />
      <ProfileScreen />
    </SessionProvider>,
  )
}

async function openEditor(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Редагувати профіль' }))
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
  stored = { ...saved }
  patchAnswer = undefined
  serve()
})

describe('ProfileScreen: перегляд', () => {
  it('за замовчуванням показує збережений профіль як дані, а не як форму', async () => {
    renderProfile()

    expect(await screen.findByRole('button', { name: 'Редагувати профіль' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Профіль' })).toBeInTheDocument()
    expect(screen.getByText('marta@example.com')).toBeInTheDocument()

    const facts = screen.getByRole('region', { name: 'Дані профілю' })

    expect(facts).toHaveTextContent('Марта')
    expect(facts).toHaveTextContent('Читаю фантастику')
    expect(facts).toHaveTextContent('Для друзів')
    expect(facts).toHaveTextContent('Друзі бачать')
    expect(facts).not.toHaveTextContent('Аватар не додано.')

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Зберегти' })).not.toBeInTheDocument()
  })

  it('без аватара й біо показує це словами; вимкнений показ тримачів — теж', async () => {
    stored = { ...saved, avatarUrl: null, bio: null, showHolderNames: false }
    renderProfile()

    const facts = await screen.findByRole('region', { name: 'Дані профілю' })

    expect(facts).toHaveTextContent('Аватар не додано.')
    expect(facts).toHaveTextContent('Ще нічого не розповіли.')
    expect(facts).toHaveTextContent('Друзі не бачать')
  })

  it('непідтверджений email: лист можна надіслати ще раз, і це видно й після переходу в редагування', async () => {
    const user = userEvent.setup()

    stored = { ...saved, emailVerified: false }
    renderProfile()

    expect(await screen.findByText('Адресу ще не підтверджено.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Надіслати лист ще раз' }))

    expect(await screen.findByText('Лист надіслано — перевірте пошту.')).toBeInTheDocument()
    expect(apiRequest).toHaveBeenCalledWith(
      '/auth/email-verification',
      expect.objectContaining({ method: 'POST' }),
    )

    await openEditor(user)

    expect(screen.getByText('Лист надіслано — перевірте пошту.')).toBeInTheDocument()
  })

  it('підтверджений email не показує попередження', async () => {
    renderProfile()

    await screen.findByRole('button', { name: 'Редагувати профіль' })

    expect(screen.queryByText('Адресу ще не підтверджено.')).not.toBeInTheDocument()
  })
})

describe('ProfileScreen: редагування', () => {
  it('«Редагувати профіль» відкриває форму з актуальними збереженими значеннями', async () => {
    const user = userEvent.setup()

    renderProfile()
    await openEditor(user)

    expect(screen.getByLabelText('Імʼя')).toHaveValue('Марта')
    expect(screen.getByLabelText('Посилання на аватар')).toHaveValue(
      'https://img.example/marta.png',
    )
    expect(screen.getByLabelText('Про себе')).toHaveValue('Читаю фантастику')
    expect(screen.getByLabelText('Видимість бібліотеки за замовчуванням')).toHaveValue('FRIENDS')
    expect(screen.getByLabelText('Друзі бачитимуть, хто читає мої книжки')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Редагувати профіль' })).not.toBeInTheDocument()
  })

  it('успішне збереження: PATCH з null для очищених полів, нові дані в сесії й у перегляді', async () => {
    const user = userEvent.setup()

    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Імʼя'))
    await user.type(screen.getByLabelText('Імʼя'), 'Марта Коваль')
    await user.clear(screen.getByLabelText('Посилання на аватар'))
    await user.clear(screen.getByLabelText('Про себе'))
    await user.selectOptions(
      screen.getByLabelText('Видимість бібліотеки за замовчуванням'),
      'PRIVATE',
    )
    await user.click(screen.getByLabelText('Друзі бачитимуть, хто читає мої книжки'))

    // The draft is local: nothing outside the form has changed yet.
    expect(screen.getByRole('status', { name: 'Користувач сесії' })).toHaveTextContent('Марта')
    expect(patches()).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Зміни збережено.')).toBeInTheDocument()
    expect(patches()).toEqual([
      expect.objectContaining({
        body: {
          displayName: 'Марта Коваль',
          avatarUrl: null,
          bio: null,
          libraryVisibility: 'PRIVATE',
          showHolderNames: false,
        },
      }),
    ])

    const facts = screen.getByRole('region', { name: 'Дані профілю' })

    expect(facts).toHaveTextContent('Марта Коваль')
    expect(facts).toHaveTextContent('Аватар не додано.')
    expect(facts).toHaveTextContent('Ще нічого не розповіли.')
    expect(facts).toHaveTextContent('Приватна — тільки я')
    expect(facts).toHaveTextContent('Друзі не бачать')
    expect(screen.getByRole('status', { name: 'Користувач сесії' })).toHaveTextContent(
      'Марта Коваль',
    )
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('повторне відкриття після збереження показує щойно збережені значення', async () => {
    const user = userEvent.setup()

    renderProfile()
    await openEditor(user)
    await user.clear(screen.getByLabelText('Про себе'))
    await user.type(screen.getByLabelText('Про себе'), 'Тепер детективи')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))
    await screen.findByText('Зміни збережено.')

    await openEditor(user)

    expect(screen.getByLabelText('Про себе')).toHaveValue('Тепер детективи')
    expect(screen.queryByText('Зміни збережено.')).not.toBeInTheDocument()
  })

  it('«Скасувати» повертає до перегляду без PATCH, а повторне відкриття — без чернетки й помилок', async () => {
    const user = userEvent.setup()

    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Імʼя'))
    await user.type(screen.getByLabelText('Імʼя'), 'М')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))
    expect(await screen.findByText('Імʼя закоротке')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(screen.getByRole('region', { name: 'Дані профілю' })).toHaveTextContent('Марта')
    expect(screen.getByRole('status', { name: 'Користувач сесії' })).toHaveTextContent('Марта')
    expect(patches()).toHaveLength(0)

    await openEditor(user)

    expect(screen.getByLabelText('Імʼя')).toHaveValue('Марта')
    expect(screen.queryByText('Імʼя закоротке')).not.toBeInTheDocument()
  })

  it('помилка валідації: без запиту, форма лишається відкритою з введеними значеннями', async () => {
    const user = userEvent.setup()

    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Посилання на аватар'))
    await user.type(screen.getByLabelText('Посилання на аватар'), 'не посилання')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Некоректне посилання')).toBeInTheDocument()
    expect(screen.getByLabelText('Посилання на аватар')).toHaveValue('не посилання')
    expect(screen.getByLabelText('Посилання на аватар')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled()
    expect(patches()).toHaveLength(0)
  })

  it('помилка API: форма лишається відкритою, значення збережені, сесія й перегляд — без змін', async () => {
    const user = userEvent.setup()

    patchAnswer = () =>
      Promise.reject(
        new ApiRequestError(400, {
          code: 'VALIDATION_ERROR',
          message: 'Профіль не збережено',
        }),
      )
    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Імʼя'))
    await user.type(screen.getByLabelText('Імʼя'), 'Марта Коваль')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Профіль не збережено')).toBeInTheDocument()
    expect(screen.getByLabelText('Імʼя')).toHaveValue('Марта Коваль')
    expect(screen.getByRole('button', { name: 'Зберегти' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeEnabled()
    expect(screen.getByRole('status', { name: 'Користувач сесії' })).toHaveTextContent('Марта')
    expect(screen.queryByText('Зміни збережено.')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(screen.getByRole('region', { name: 'Дані профілю' })).not.toHaveTextContent(
      'Марта Коваль',
    )
  })

  it('поки PATCH триває, повторне збереження й скасування заблоковані — рівно один запит', async () => {
    const user = userEvent.setup()
    let finish: (value: Me) => void = () => undefined

    patchAnswer = (body) =>
      new Promise<Me>((resolve) => {
        finish = (value) => {
          resolve({ ...value, ...body })
        }
      })
    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Імʼя'))
    await user.type(screen.getByLabelText('Імʼя'), 'Марта Коваль')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    const saving = screen.getByRole('button', { name: 'Зберігаю…' })

    expect(saving).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()

    await user.click(saving)
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(patches()).toHaveLength(1)
    expect(screen.getByLabelText('Імʼя')).toHaveValue('Марта Коваль')

    finish(saved)

    expect(await screen.findByText('Зміни збережено.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Дані профілю' })).toHaveTextContent('Марта Коваль')
    expect(patches()).toHaveLength(1)
  })

  it('поки PATCH триває, поля заблоковані: правка після «Зберегти» не губиться мовчки разом із формою', async () => {
    const user = userEvent.setup()
    let finish: () => void = () => undefined

    patchAnswer = (body) =>
      new Promise<Me>((resolve) => {
        finish = () => {
          stored = { ...stored, ...body }
          resolve(stored)
        }
      })
    renderProfile()
    await openEditor(user)

    await user.clear(screen.getByLabelText('Про себе'))
    await user.type(screen.getByLabelText('Про себе'), 'Надіслане біо')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    for (const label of [
      'Імʼя',
      'Посилання на аватар',
      'Про себе',
      'Видимість бібліотеки за замовчуванням',
      'Друзі бачитимуть, хто читає мої книжки',
    ]) {
      expect(screen.getByLabelText(label)).toBeDisabled()
    }

    await user.type(screen.getByLabelText('Про себе'), ' і пізня правка')
    await user.click(screen.getByLabelText('Друзі бачитимуть, хто читає мої книжки'))

    expect(screen.getByLabelText('Про себе')).toHaveValue('Надіслане біо')
    expect(screen.getByLabelText('Друзі бачитимуть, хто читає мої книжки')).toBeChecked()

    finish()

    expect(await screen.findByText('Зміни збережено.')).toBeInTheDocument()

    const facts = screen.getByRole('region', { name: 'Дані профілю' })

    expect(facts).toHaveTextContent('Надіслане біо')
    expect(facts).not.toHaveTextContent('пізня правка')
    expect(facts).toHaveTextContent('Друзі бачать')
    expect(patches()).toHaveLength(1)
  })

  it('після помилки API поля знову доступні для правки', async () => {
    const user = userEvent.setup()

    patchAnswer = () =>
      Promise.reject(
        new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервіс недоступний' }),
      )
    renderProfile()
    await openEditor(user)
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Сервіс недоступний')).toBeInTheDocument()
    expect(screen.getByLabelText('Про себе')).toBeEnabled()

    await user.type(screen.getByLabelText('Про себе'), '!')

    expect(screen.getByLabelText('Про себе')).toHaveValue('Читаю фантастику!')
  })
})

describe('ProfileScreen: сесія', () => {
  it('поки сесія перевіряється, показує завантаження і нічого не редагує', () => {
    apiRequest.mockImplementation(() => new Promise(() => undefined))
    renderProfile()

    expect(screen.getByText('Завантажую профіль…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Редагувати профіль' })).not.toBeInTheDocument()
  })

  it('гостя переадресовує на логін', async () => {
    apiRequest.mockRejectedValue(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: '' }))
    renderProfile()

    expect(await screen.findByText('Потрібен вхід. Переадресовую…')).toBeInTheDocument()
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/login')
    })
    expect(screen.queryByRole('button', { name: 'Редагувати профіль' })).not.toBeInTheDocument()
  })

  it('збій перевірки сесії показує помилку, а не переадресацію', async () => {
    apiRequest.mockRejectedValue(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервіс недоступний' }),
    )
    renderProfile()

    expect(await screen.findByText('Сервіс недоступний')).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
