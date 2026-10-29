/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import RegisterPage from './page'

/**
 * BS-129: the registration form refuses a blocked email domain next to the email
 * field — from the shared precheck and from the server's `EMAIL_DOMAIN_BLOCKED` —
 * without a session, without navigation and without losing what was typed.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const mockReplace = jest.fn()
const mockPush = jest.fn()
let mockSearchParams = new URLSearchParams()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const REFUSAL = 'Реєстрація з цією поштовою адресою недоступна. Використайте email з іншим доменом.'
const PASSWORD = 'correct horse battery staple'

function SessionProbe() {
  const { state } = useSession()

  return <p>{state.status === 'authenticated' ? `Вітаю, ${state.user.id}` : 'Гість'}</p>
}

function registerCalls(): unknown[][] {
  return mockApiRequest.mock.calls.filter(([path]) => path === '/auth/register')
}

/** The server: `/auth/register` answers with whatever the test decides per address. */
function serveRegister(answer: (email: string) => Promise<unknown>): void {
  mockApiRequest.mockImplementation((path: string, init?: { body?: { email: string } }) => {
    if (path === '/auth/session') {
      return Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
    }
    if (path === '/auth/register') return answer(init?.body?.email ?? '')

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })
}

const registered = () => Promise.resolve({ user: { id: 'user-new', displayName: 'Нова' } })

async function renderForm(): Promise<UserEvent> {
  const user = userEvent.setup()

  render(
    <SessionProvider>
      <RegisterPage />
      <SessionProbe />
    </SessionProvider>,
  )

  expect(await screen.findByText('Гість')).toBeInTheDocument()

  await user.type(screen.getByLabelText('Імʼя'), 'Нова Людина')
  await user.type(screen.getByLabelText('Пароль'), PASSWORD)

  return user
}

async function submitWithEmail(user: UserEvent, email: string): Promise<void> {
  await user.clear(screen.getByLabelText('Email'))
  await user.type(screen.getByLabelText('Email'), email)
  await user.click(screen.getByRole('button', { name: 'Створити акаунт' }))
}

function expectRefusalAtEmail(): void {
  const field = screen.getByLabelText('Email')
  const alert = screen.getByRole('alert')

  expect(alert).toHaveTextContent(REFUSAL)
  expect(field).toHaveAttribute('aria-invalid', 'true')
  expect(field).toHaveAccessibleDescription(REFUSAL)
}

/** BS-146: one navigation away, owned by the page's session effect — never a second one from submit. */
function expectOneNavigationTo(target: string): void {
  expect(mockReplace).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith(target)
  expect(mockPush).not.toHaveBeenCalled()
}

function expectStillOnTheForm(email: string): void {
  expect(screen.getByLabelText('Email')).toHaveValue(email)
  expect(screen.getByLabelText('Імʼя')).toHaveValue('Нова Людина')
  expect(screen.getByLabelText('Пароль')).toHaveValue(PASSWORD)
  expect(screen.getByText('Гість')).toBeInTheDocument()
  expect(mockPush).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSearchParams = new URLSearchParams()
})

it.each([
  ['ASCII', 'user@example.ru'],
  ['піддомен і регістр', 'User@Mail.Example.SU'],
  ['Unicode', 'user@пошта.рф'],
  ['Unicode .москва', 'user@книги.москва'],
  ['Punycode', 'user@xn--80a1acn3a.xn--p1ai'],
  ['Punycode .рус', 'user@example.xn--p1acf'],
])(
  '%s: показує погоджену відмову біля email без запиту, сесії й переходу',
  async (_case, email) => {
    serveRegister(registered)
    const user = await renderForm()

    await submitWithEmail(user, email)

    expectRefusalAtEmail()
    expectStillOnTheForm(email)
    expect(registerCalls()).toHaveLength(0)
  },
)

it('після відмови повтор із дозволеною адресою реєструє й переходить', async () => {
  serveRegister(registered)
  const user = await renderForm()

  await submitWithEmail(user, 'user@пошта.рф')
  expectRefusalAtEmail()

  await submitWithEmail(user, 'User@Example.ru.com')

  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-new')).toBeInTheDocument()
  })
  expect(registerCalls()).toEqual([
    [
      '/auth/register',
      expect.objectContaining({
        body: { displayName: 'Нова Людина', email: 'user@example.ru.com', password: PASSWORD },
      }),
    ],
  ])
  expectOneNavigationTo('/')
})

it('серверна відмова EMAIL_DOMAIN_BLOCKED показується біля email; повтор успішний', async () => {
  // A server whose list is ahead of the client's: the precheck lets the address
  // through, and the server's own refusal must still reach the email field.
  serveRegister((email) =>
    email === 'user@blocked-by-server.example'
      ? Promise.reject(new ApiRequestError(400, { code: 'EMAIL_DOMAIN_BLOCKED', message: REFUSAL }))
      : registered(),
  )
  const user = await renderForm()

  await submitWithEmail(user, 'user@blocked-by-server.example')

  await waitFor(() => {
    expectRefusalAtEmail()
  })
  expectStillOnTheForm('user@blocked-by-server.example')
  expect(registerCalls()).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Створити акаунт' })).toBeEnabled()

  await submitWithEmail(user, 'user@example.com')

  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-new')).toBeInTheDocument()
  })
  expect(registerCalls()).toHaveLength(2)
  expectOneNavigationTo('/')
})

it('заблокований домен не ховає помилок інших полів', async () => {
  serveRegister(registered)
  const user = userEvent.setup()

  render(
    <SessionProvider>
      <RegisterPage />
    </SessionProvider>,
  )

  await user.type(await screen.findByLabelText('Email'), 'user@example.ru')
  await user.click(screen.getByRole('button', { name: 'Створити акаунт' }))

  expect(screen.getByLabelText('Email')).toHaveAccessibleDescription(REFUSAL)
  expect(screen.getByLabelText('Імʼя')).toHaveAttribute('aria-invalid', 'true')
  expect(registerCalls()).toHaveLength(0)
})

describe('BS-146: back to the page that asked for an account', () => {
  const TARGET = '/works/w-1?edition=e-2#holders'

  it('keeps returnTo through a refused address and a retry, then opens the page', async () => {
    mockSearchParams = new URLSearchParams({ returnTo: TARGET })
    serveRegister((email) =>
      email === 'taken@example.com'
        ? Promise.reject(new ApiRequestError(409, { code: 'EMAIL_TAKEN', message: 'Зайнято' }))
        : registered(),
    )
    const user = await renderForm()

    await submitWithEmail(user, 'taken@example.com')

    expect(await screen.findByText('Зайнято')).toBeInTheDocument()
    expectStillOnTheForm('taken@example.com')
    expect(screen.getByRole('link', { name: 'Увійти' })).toHaveAttribute(
      'href',
      `/login?returnTo=${encodeURIComponent(TARGET)}`,
    )

    await submitWithEmail(user, 'new@example.com')

    await waitFor(() => {
      expect(screen.getByText('Вітаю, user-new')).toBeInTheDocument()
    })
    expectOneNavigationTo(TARGET)
  })

  it.each(['https://evil.example/works', '//evil.example', '/login', '/invite#token'])(
    'falls back to the home page for returnTo %j and does not pass it on',
    async (returnTo) => {
      mockSearchParams = new URLSearchParams({ returnTo })
      serveRegister(registered)
      const user = await renderForm()

      expect(screen.getByRole('link', { name: 'Увійти' })).toHaveAttribute('href', '/login')

      await submitWithEmail(user, 'new@example.com')

      await waitFor(() => {
        expect(screen.getByText('Вітаю, user-new')).toBeInTheDocument()
      })
      expectOneNavigationTo('/')
    },
  )
})
