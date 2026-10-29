/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import LoginPage from './page'

/**
 * BS-146: after signing in, the visitor is back on the page that sent them here — through a wrong
 * password and a retry too — and anything but a BookSwap page falls back to the home page.
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

const PASSWORD = 'correct horse battery staple'
const TARGET = '/loans?tab=history&historyView=lent#loan-7'
const WRONG = 'Неправильний email або пароль.'

function SessionProbe() {
  const { state } = useSession()

  return <p>{state.status === 'authenticated' ? `Вітаю, ${state.user.id}` : 'Гість'}</p>
}

function loginCalls(): unknown[][] {
  return mockApiRequest.mock.calls.filter(([path]) => path === '/auth/login')
}

/** A guest; `/auth/login` accepts only `PASSWORD`. */
function serveLogin(): void {
  mockApiRequest.mockImplementation((path: string, init?: { body?: { password: string } }) => {
    if (path === '/auth/session') {
      return Promise.reject(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: 'guest' }))
    }
    if (path === '/auth/login') {
      return init?.body?.password === PASSWORD
        ? Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })
        : Promise.reject(new ApiRequestError(401, { code: 'INVALID_CREDENTIALS', message: WRONG }))
    }

    return Promise.reject(new Error(`unexpected apiRequest ${path}`))
  })
}

async function renderForm(returnTo?: string): Promise<UserEvent> {
  mockSearchParams = new URLSearchParams(returnTo === undefined ? {} : { returnTo })
  const user = userEvent.setup()

  render(
    <SessionProvider>
      <LoginPage />
      <SessionProbe />
    </SessionProvider>,
  )

  expect(await screen.findByText('Гість')).toBeInTheDocument()

  return user
}

async function signIn(user: UserEvent, password: string): Promise<void> {
  await user.clear(screen.getByLabelText('Email'))
  await user.type(screen.getByLabelText('Email'), 'a@example.com')
  await user.clear(screen.getByLabelText('Пароль'))
  await user.type(screen.getByLabelText('Пароль'), password)
  await user.click(screen.getByRole('button', { name: 'Увійти' }))
}

async function expectSignedIn(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByText('Вітаю, user-a')).toBeInTheDocument()
  })
}

/** One navigation away, owned by the page's session effect — never a second one from submit. */
function expectOneNavigationTo(target: string): void {
  expect(mockReplace).toHaveBeenCalledTimes(1)
  expect(mockReplace).toHaveBeenCalledWith(target)
  expect(mockPush).not.toHaveBeenCalled()
}

beforeEach(() => {
  jest.clearAllMocks()
  serveLogin()
})

it('opens the requested page — path, query and fragment — after signing in', async () => {
  const user = await renderForm(TARGET)

  await signIn(user, PASSWORD)

  await expectSignedIn()
  expectOneNavigationTo(TARGET)
})

it('keeps returnTo through a wrong password: the retry still comes back to the page', async () => {
  const user = await renderForm(TARGET)

  await signIn(user, 'wrong password, long enough')

  expect(await screen.findByText(WRONG)).toBeInTheDocument()
  expect(screen.getByText('Гість')).toBeInTheDocument()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: 'Зареєструватися' })).toHaveAttribute(
    'href',
    `/register?returnTo=${encodeURIComponent(TARGET)}`,
  )

  await signIn(user, PASSWORD)

  await expectSignedIn()
  expect(loginCalls()).toHaveLength(2)
  expectOneNavigationTo(TARGET)
})

it('goes to the home page without returnTo', async () => {
  const user = await renderForm()

  expect(screen.getByRole('link', { name: 'Зареєструватися' })).toHaveAttribute('href', '/register')

  await signIn(user, PASSWORD)

  await expectSignedIn()
  expectOneNavigationTo('/')
})

it.each([
  'https://evil.example/library',
  '//evil.example',
  '/\\evil.example',
  'javascript:alert(1)',
  '/\t/evil.example',
  '/login?returnTo=%2Flibrary',
  '/register',
  '/invite#token',
])('falls back to the home page for returnTo %j and does not pass it on', async (returnTo) => {
  const user = await renderForm(returnTo)

  expect(screen.getByRole('link', { name: 'Зареєструватися' })).toHaveAttribute('href', '/register')

  await signIn(user, PASSWORD)

  await expectSignedIn()
  expectOneNavigationTo('/')
})

it('keeps the invitation flow: back to the bare /invite', async () => {
  const user = await renderForm('/invite')

  await signIn(user, PASSWORD)

  await expectSignedIn()
  expectOneNavigationTo('/invite')
})

it('sends someone already signed in straight to the page, without the form', async () => {
  mockApiRequest.mockImplementation((path: string) =>
    path === '/auth/session'
      ? Promise.resolve({ user: { id: 'user-a', displayName: 'A' } })
      : Promise.reject(new Error(`unexpected apiRequest ${path}`)),
  )
  mockSearchParams = new URLSearchParams({ returnTo: TARGET })

  render(
    <SessionProvider>
      <LoginPage />
    </SessionProvider>,
  )

  await waitFor(() => {
    expectOneNavigationTo(TARGET)
  })
  expect(screen.queryByLabelText('Email')).not.toBeInTheDocument()
  expect(loginCalls()).toHaveLength(0)
})
