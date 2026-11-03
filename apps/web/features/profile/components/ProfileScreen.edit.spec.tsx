/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Me, ProfileSummary, UpdateProfileRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { SessionProvider, useSession } from '@/app/lib/use-session'
import { ToastProvider } from '@/components/ui/toast'
import { SAVE_TIMEOUT_MS } from '../model/profile-form'
import { ProfileScreen } from './ProfileScreen'

/**
 * BS-148, sub-stage G: `/profile/edit` by role, label and text. `apiRequest` is a small in-memory
 * server: the session reads what the last successful PATCH or photo upload stored.
 */

// jsdom has no object URLs; the photo preview needs one per chosen file.
let previewCount = 0
const createObjectURL = jest.fn(() => `blob:preview-${String((previewCount += 1))}`)
const revokeObjectURL = jest.fn()

Object.assign(URL, { createObjectURL, revokeObjectURL })

// jsdom has no `PointerEvent`; Base UI builds one when a select is opened (as in `SelectField.spec`).
window.PointerEvent ??= class PointerEvent extends MouseEvent {} as typeof window.PointerEvent

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
  body?: unknown
  signal?: AbortSignal
}

const saved: Me = {
  id: 'user-1',
  email: 'marta@example.com',
  emailVerified: true,
  displayName: 'Марта',
  handle: 'marta',
  city: 'Вроцлав',
  avatarUrl: null,
  bio: 'Читаю фантастику',
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  friendsOfFriendsAccess: false,
  loanRequestsPaused: false,
  defaultLoanTermDays: null,
  ownerDueReminders: true,
  createdAt: '2026-09-05T08:00:00.000Z',
}

const summary: ProfileSummary = {
  stats: { copies: 0, friends: 0, lentLoans: 0, wishlist: 0 },
  reliability: { returnedOnTime: 0, returnedWithDue: 0, averageLoanDays: null, outNow: 0 },
  books: { items: [], total: 0 },
  friends: { items: [], total: 0 },
  activity: [],
}

const TAKEN = ['taras', 'oksana']
const PHOTO_URL = 'https://avatars.example/avatars/user-1/a.webp'

let stored: Me
/** Replaces the default PATCH answer; the default stores the body like the API does. */
let patchAnswer: ((body: UpdateProfileRequest) => Promise<Me>) | undefined
let availabilityAnswer: ((handle: string) => Promise<{ available: boolean }>) | undefined
/** The upload's refusal, when the server should refuse it. */
let avatarRefusal: ApiRequestError | undefined
/** Replaces the photo answers; the default stores the change like the API does. */
let avatarAnswer: ((method: 'POST' | 'DELETE', signal?: AbortSignal) => Promise<Me>) | undefined

/** An answer held back until the test lets it land — in the order the test chooses. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })

  return { promise, resolve, reject }
}

function serve(): void {
  apiRequest.mockImplementation((path: string, options: RequestOptions = {}) => {
    if (path === '/auth/session') {
      return Promise.resolve({ user: stored, features: { guestLoans: false } })
    }
    if (path === '/me/profile-summary') return Promise.resolve(summary)

    const availability = /^\/users\/handles\/([^/]+)\/availability$/.exec(path)

    if (availability !== null) {
      const handle = decodeURIComponent(availability[1] ?? '')

      return availabilityAnswer === undefined
        ? Promise.resolve({ available: !TAKEN.includes(handle) })
        : availabilityAnswer(handle)
    }
    if (path === '/me' && options.method === 'PATCH') {
      const body = options.body as UpdateProfileRequest

      if (patchAnswer !== undefined) return patchAnswer(body)

      stored = { ...stored, ...body }

      return Promise.resolve(stored)
    }
    if (path === '/me/avatar' && avatarAnswer !== undefined) {
      return avatarAnswer(options.method === 'DELETE' ? 'DELETE' : 'POST', options.signal)
    }
    if (path === '/me/avatar' && options.method === 'POST') {
      if (avatarRefusal !== undefined) return Promise.reject(avatarRefusal)

      stored = { ...stored, avatarUrl: PHOTO_URL }

      return Promise.resolve(stored)
    }
    if (path === '/me/avatar' && options.method === 'DELETE') {
      stored = { ...stored, avatarUrl: null }

      return Promise.resolve(stored)
    }

    return Promise.reject(new Error(`unexpected ${path}`))
  })
}

function requests(path: string, method: string): RequestOptions[] {
  return apiRequest.mock.calls
    .filter(([called, options]) => called === path && (options as RequestOptions).method === method)
    .map(([, options]) => options as RequestOptions)
}

function patches(): unknown[] {
  return requests('/me', 'PATCH').map((options) => options.body)
}

const oksana: Me = {
  ...saved,
  id: 'user-2',
  email: 'oksana@example.com',
  displayName: 'Оксана',
  handle: 'oksana',
}

/**
 * What the rest of the app sees: the session user, outside the profile screen. Its two buttons are
 * the rest of the app changing the session — a logout, another account's login.
 */
function SessionProbe() {
  const { state, setGuest, setUser } = useSession()

  return (
    <>
      <output aria-label="Користувач сесії">
        {state.status === 'authenticated' ? JSON.stringify(state.user) : state.status}
      </output>
      <button type="button" onClick={setGuest}>
        Вийти з акаунта
      </button>
      <button
        type="button"
        onClick={() => {
          setUser(oksana)
        }}
      >
        Увійти як Оксана
      </button>
    </>
  )
}

function sessionStatus(): string {
  return screen.getByRole('status', { name: 'Користувач сесії' }).textContent ?? ''
}

function sessionUser(): Me {
  return JSON.parse(
    screen.getByRole('status', { name: 'Користувач сесії' }).textContent ?? '{}',
  ) as Me
}

async function renderEdit() {
  const user = userEvent.setup()

  render(
    withQueryClient(
      <SessionProvider>
        <ToastProvider>
          <SessionProbe />
          <ProfileScreen mode="edit" />
        </ToastProvider>
      </SessionProvider>,
    ),
  )

  await screen.findByRole('heading', { level: 1, name: 'Редагування профілю' })

  return user
}

const saveButton = () => screen.getByRole('button', { name: 'Зберегти' })
const handleField = () => screen.getByRole('textbox', { name: 'Нік' })

beforeEach(() => {
  jest.clearAllMocks()
  previewCount = 0
  window.history.replaceState(null, '', '/profile/edit')
  stored = saved
  patchAnswer = undefined
  availabilityAnswer = undefined
  avatarRefusal = undefined
  avatarAnswer = undefined
  serve()
})

describe('/profile/edit: форма', () => {
  it('returns a guest to the edit route with its query and fragment after sign-in', async () => {
    const address = '/profile/edit?from=profile#bio'

    window.history.replaceState(null, '', address)
    apiRequest.mockRejectedValue(new ApiRequestError(401, { code: 'UNAUTHORIZED', message: '' }))

    render(
      withQueryClient(
        <SessionProvider>
          <ToastProvider>
            <ProfileScreen mode="edit" />
          </ToastProvider>
        </SessionProvider>,
      ),
    )

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith(`/login?returnTo=${encodeURIComponent(address)}`)
    })
    expect(apiRequest.mock.calls.map(([path]) => path)).toEqual(['/auth/session'])
    expect(screen.queryByRole('textbox', { name: 'Нік' })).not.toBeInTheDocument()
  })

  it('починає зі збережених даних; «Зберегти» неактивна, доки нічого не змінено', async () => {
    await renderEdit()

    expect(screen.getByRole('textbox', { name: 'Ім’я' })).toHaveValue('Марта')
    expect(handleField()).toHaveValue('marta')
    expect(screen.getByRole('textbox', { name: 'Місто (необов’язково)' })).toHaveValue('Вроцлав')
    expect(screen.getByRole('textbox', { name: 'Про себе (необов’язково)' })).toHaveValue(
      'Читаю фантастику',
    )
    expect(screen.getByText('16/500')).toBeInTheDocument()
    // Under the nickname only a problem is shown (product decision, 27.10.2026).
    expect(screen.queryByText('Це ваш поточний нік')).not.toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    // The rest of the page stays: the settings are still there under the form.
    expect(screen.getByRole('region', { name: 'Налаштування позичання' })).toBeInTheDocument()
  })

  it('надсилає лише змінене; успіх — сесія з новим профілем, тост і повернення на /profile', async () => {
    const user = await renderEdit()
    const city = screen.getByRole('textbox', { name: 'Місто (необов’язково)' })

    await user.clear(city)
    await user.type(city, 'Київ')
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ city: 'Київ' }])
    expect(sessionUser().city).toBe('Київ')
    expect(await screen.findByText('Профіль оновлено')).toBeInTheDocument()
  })

  it('порожнє імʼя — словами макета після виходу з поля; помилка зникає, щойно його виправляють', async () => {
    const user = await renderEdit()
    const name = screen.getByRole('textbox', { name: 'Ім’я' })

    await user.clear(name)
    await user.tab()

    expect(await screen.findByText('Вкажіть ім’я — так друзі вас упізнають')).toBeInTheDocument()
    expect(name).toHaveAttribute('aria-invalid', 'true')

    await user.type(name, 'М')

    expect(screen.queryByText('Вкажіть ім’я — так друзі вас упізнають')).not.toBeInTheDocument()
  })

  it('поки збереження триває — уся форма заблокована, кнопка каже «Зберігаємо…»', async () => {
    let answer: (user: Me) => void = () => undefined

    patchAnswer = () =>
      new Promise<Me>((resolve) => {
        answer = resolve
      })
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())

    expect(await screen.findByRole('button', { name: 'Зберігаємо…' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Ім’я' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()

    answer({ ...stored, displayName: 'Марта К' })

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
  })
})

describe('/profile/edit: нік', () => {
  it('пише нижнім регістром без пробілів; зайнятий нік блокує «Зберегти»', async () => {
    const user = await renderEdit()

    await user.clear(handleField())
    await user.type(handleField(), 'Ta ras')

    expect(handleField()).toHaveValue('taras')
    expect(screen.queryByText('Перевіряємо…')).not.toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    expect(await screen.findByText('Цей нік уже зайнятий')).toBeInTheDocument()
    expect(handleField()).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toBeDisabled()
  })

  it('вільний нік дозволяє зберегти', async () => {
    const user = await renderEdit()

    await user.clear(handleField())
    await user.type(handleField(), 'marta_reads')

    await waitFor(() => {
      expect(saveButton()).toBeEnabled()
    })
    expect(screen.queryByText('✓ Нік вільний')).not.toBeInTheDocument()

    await user.click(saveButton())

    await waitFor(() => {
      expect(patches()).toEqual([{ handle: 'marta_reads' }])
    })
  })

  it('збій перевірки блокує «Зберегти», доки «Перевірити ще раз» не скаже, що нік вільний', async () => {
    let failing = true

    availabilityAnswer = () =>
      failing
        ? Promise.reject(
            new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
          )
        : Promise.resolve({ available: true })
    const user = await renderEdit()

    await user.clear(handleField())
    await user.type(handleField(), 'marta_reads')

    expect(await screen.findByText('Не вдалося перевірити нік')).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    failing = false
    await user.click(screen.getByRole('button', { name: 'Перевірити ще раз' }))

    await waitFor(() => {
      expect(saveButton()).toBeEnabled()
    })
    expect(screen.queryByText('Не вдалося перевірити нік')).not.toBeInTheDocument()
  })

  it('409 під час збереження — помилка під ніком і фокус на ньому; форма лишається', async () => {
    patchAnswer = () =>
      Promise.reject(
        new ApiRequestError(409, { code: 'HANDLE_TAKEN', message: 'Цей нік уже зайнятий' }),
      )
    const user = await renderEdit()

    await user.clear(handleField())
    await user.type(handleField(), 'marta_reads')
    await waitFor(() => {
      expect(saveButton()).toBeEnabled()
    })
    await user.click(saveButton())

    expect(await screen.findByText('Цей нік уже зайнятий')).toBeInTheDocument()
    await waitFor(() => {
      expect(handleField()).toHaveFocus()
    })
    expect(saveButton()).toBeDisabled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

describe('/profile/edit: збій збереження', () => {
  it('5xx — банер, введене лишається; «Спробувати ще» надсилає знову', async () => {
    let failing = true

    patchAnswer = (body) => {
      if (failing) {
        return Promise.reject(
          new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервіс недоступний' }),
        )
      }

      stored = { ...stored, ...body }

      return Promise.resolve(stored)
    }
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())

    const banner = await screen.findByRole('alert')

    expect(banner).toHaveTextContent(
      'Не вдалося зберегти. Перевірте з’єднання — введені дані нікуди не зникнуть.',
    )
    expect(screen.getByRole('textbox', { name: 'Ім’я' })).toHaveValue('Марта К')
    expect(mockReplace).not.toHaveBeenCalled()

    failing = false
    await user.click(within(banner).getByRole('button', { name: 'Спробувати ще' }))

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ displayName: 'Марта К' }, { displayName: 'Марта К' }])
  })
})

describe('/profile/edit: скасування', () => {
  it('без змін «Скасувати» одразу повертає на /profile', async () => {
    const user = await renderEdit()

    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(mockReplace).toHaveBeenCalledWith('/profile')
  })

  it('зі змінами — питає; «Продовжити редагування» лишає введене й повертає фокус на «Скасувати»', async () => {
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Місто (необов’язково)' }), '-Дольни')
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    const question = screen.getByRole('alertdialog', { name: 'Скасувати зміни?' })

    expect(question).toHaveAccessibleDescription('Внесене не збережеться.')

    const keep = within(question).getByRole('button', { name: 'Продовжити редагування' })

    // Base UI moves focus into the dialog and back out on an animation frame, not in the click itself.
    await waitFor(() => {
      expect(keep).toHaveFocus()
    })

    await user.click(keep)

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Скасувати' })).toHaveFocus()
    })
    expect(screen.getByRole('textbox', { name: 'Місто (необов’язково)' })).toHaveValue(
      'Вроцлав-Дольни',
    )
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('Esc, яким закривають список налаштування під формою, форму не скасовує', async () => {
    const user = await renderEdit()

    await user.click(screen.getByRole('combobox', { name: 'Термін за замовчуванням' }))
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    })
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('«Скасувати зміни» відкидає чернетку без запиту', async () => {
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.keyboard('{Escape}')

    // Esc is pressed in the name field: the dialog takes focus on an animation frame, which blurs the
    // field, and the form checks it asynchronously. Waiting for that focus keeps the check in the test.
    const question = screen.getByRole('alertdialog', { name: 'Скасувати зміни?' })

    await waitFor(() => {
      expect(within(question).getByRole('button', { name: 'Продовжити редагування' })).toHaveFocus()
    })
    await user.click(within(question).getByRole('button', { name: 'Скасувати зміни' }))

    // The dialog closes asynchronously; waiting for it keeps its updates inside the test.
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })
    expect(mockReplace).toHaveBeenCalledWith('/profile')
    expect(patches()).toEqual([])
  })
})

function photoFile(name = 'me.jpg'): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' })
}

function photoRequests(): RequestOptions[] {
  return [...requests('/me/avatar', 'POST'), ...requests('/me/avatar', 'DELETE')]
}

describe('/profile/edit: фото', () => {
  it('вибір фото лише показує прев’ю: жодного запиту запису, збережене фото те саме', async () => {
    const user = await renderEdit()
    const photo = photoFile()

    expect(screen.queryByRole('button', { name: 'Видалити фото' })).not.toBeInTheDocument()

    await user.upload(screen.getByLabelText('Фото профілю'), photo)

    expect(createObjectURL).toHaveBeenCalledWith(photo)
    expect(await screen.findByRole('button', { name: 'Видалити фото' })).toBeInTheDocument()
    expect(photoRequests()).toEqual([])
    expect(patches()).toEqual([])
    expect(sessionUser().avatarUrl).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  it('повторний вибір замінює лише прев’ю: попереднє звільняється, «Зберегти» надсилає останнє', async () => {
    const user = await renderEdit()
    const first = photoFile('first.jpg')
    const second = photoFile('second.jpg')

    await user.upload(screen.getByLabelText('Фото профілю'), first)
    await user.upload(screen.getByLabelText('Фото профілю'), second)

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:preview-2')
    expect(photoRequests()).toEqual([])

    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(requests('/me/avatar', 'POST').map((options) => options.body)).toEqual([second])
  })

  it('«Скасувати» з вибраним фото питає підтвердження; скасовані зміни лишають збережене фото', async () => {
    stored = { ...saved, avatarUrl: PHOTO_URL }
    const user = await renderEdit()

    await user.upload(screen.getByLabelText('Фото профілю'), photoFile())
    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    const question = screen.getByRole('alertdialog', { name: 'Скасувати зміни?' })

    await user.click(within(question).getByRole('button', { name: 'Скасувати зміни' }))
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    })

    expect(mockReplace).toHaveBeenCalledWith('/profile')
    expect(photoRequests()).toEqual([])
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)

    // The page is left: the preview goes with the form.
    cleanup()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
  })

  it('«Зберегти» завантажує вибране фото, і лише тоді воно в профілі; поля без змін не надсилаються', async () => {
    const user = await renderEdit()
    const photo = photoFile()

    await user.upload(screen.getByLabelText('Фото профілю'), photo)
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(requests('/me/avatar', 'POST').map((options) => options.body)).toEqual([photo])
    expect(patches()).toEqual([])
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)
    expect(await screen.findByText('Профіль оновлено')).toBeInTheDocument()
  })

  it('поки фото зберігається, форма заблокована й повторно не надсилає', async () => {
    const photo = deferred<Me>()

    avatarAnswer = () => photo.promise
    const user = await renderEdit()

    await user.upload(screen.getByLabelText('Фото профілю'), photoFile())
    await user.click(saveButton())

    const saving = await screen.findByRole('button', { name: 'Зберігаємо…' })

    expect(saving).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Завантажую фото…' })).toBeDisabled()
    await user.click(saving)
    expect(requests('/me/avatar', 'POST')).toHaveLength(1)

    await act(async () => {
      photo.resolve({ ...saved, avatarUrl: PHOTO_URL })
      await photo.promise
    })
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(requests('/me/avatar', 'POST')).toHaveLength(1)
  })

  it('збій завантаження: без успіху, збережене фото те саме, вибране лишається для повтору', async () => {
    let attempts = 0

    avatarAnswer = () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(
          new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Недоступно' }),
        )
      }

      stored = { ...stored, avatarUrl: PHOTO_URL }

      return Promise.resolve(stored)
    }
    const user = await renderEdit()
    const photo = photoFile()

    await user.upload(screen.getByLabelText('Фото профілю'), photo)
    await user.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Недоступно')
    expect(sessionUser().avatarUrl).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.queryByText('Профіль оновлено')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Видалити фото' })).toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()

    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(requests('/me/avatar', 'POST').map((options) => options.body)).toEqual([photo, photo])
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)
  })

  it('збереження без зміни фото не завантажує його знову', async () => {
    stored = { ...saved, avatarUrl: PHOTO_URL }
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ displayName: 'Марта К' }])
    expect(photoRequests()).toEqual([])
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)
  })

  it('«Видалити фото» прибирає його лише з форми; видаляє «Зберегти»', async () => {
    stored = { ...saved, avatarUrl: PHOTO_URL }
    const user = await renderEdit()

    await user.click(screen.getByRole('button', { name: 'Видалити фото' }))

    expect(screen.queryByRole('button', { name: 'Видалити фото' })).not.toBeInTheDocument()
    expect(photoRequests()).toEqual([])
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)

    await user.click(saveButton())

    await waitFor(() => {
      expect(sessionUser().avatarUrl).toBeNull()
    })
    expect(requests('/me/avatar', 'DELETE')).toHaveLength(1)
    expect(mockReplace).toHaveBeenCalledWith('/profile')
  })

  it('видалити щойно вибране фото — повернутися до збереженого: надсилати нічого', async () => {
    const user = await renderEdit()

    await user.upload(screen.getByLabelText('Фото профілю'), photoFile())
    await user.click(await screen.findByRole('button', { name: 'Видалити фото' }))

    expect(screen.queryByRole('button', { name: 'Видалити фото' })).not.toBeInTheDocument()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1')
    expect(saveButton()).toBeDisabled()
    expect(photoRequests()).toEqual([])
  })

  it('завеликий файл не надсилається — словами макета', async () => {
    const user = await renderEdit()
    const huge = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' })

    await user.upload(screen.getByLabelText('Фото профілю'), huge)

    expect(await screen.findByRole('alert')).toHaveTextContent('Файл завеликий — до 5 МБ')
    expect(requests('/me/avatar', 'POST')).toEqual([])
  })

  it('відмову сервера показує його словами', async () => {
    avatarRefusal = new ApiRequestError(422, {
      code: 'AVATAR_TOO_SMALL',
      message: 'Фото замале: потрібно щонайменше 256×256 пікселів',
    })
    const user = await renderEdit()

    await user.upload(
      screen.getByLabelText('Фото профілю'),
      new File([new Uint8Array([1])], 'tiny.png', { type: 'image/png' }),
    )
    await user.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Фото замале: потрібно щонайменше 256×256 пікселів',
    )
    expect(sessionUser().avatarUrl).toBeNull()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

/**
 * «Зберегти» with both the fields and the photo changed: `PATCH /me` first, the photo only after it
 * succeeded (PO decision, 03.11.2026), so a refused form never replaces the stored photo.
 */
describe('/profile/edit: поля й фото', () => {
  const renamed = 'Марта К'

  async function changeBoth() {
    const user = await renderEdit()

    await user.upload(screen.getByLabelText('Фото профілю'), photoFile())
    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())

    return user
  }

  it('спершу поля, потім фото; «Профіль оновлено» — лише після обох', async () => {
    const form = deferred<Me>()
    const photo = deferred<Me>()

    patchAnswer = () => form.promise
    avatarAnswer = () => photo.promise
    await changeBoth()

    expect(await screen.findByRole('button', { name: 'Зберігаємо…' })).toBeDisabled()
    expect(patches()).toEqual([{ displayName: renamed }])
    expect(photoRequests()).toEqual([])

    form.resolve({ ...saved, displayName: renamed })
    await waitFor(() => {
      expect(requests('/me/avatar', 'POST')).toHaveLength(1)
    })
    expect(sessionUser().displayName).toBe(renamed)
    expect(screen.getByRole('button', { name: 'Зберігаємо…' })).toBeDisabled()
    expect(mockReplace).not.toHaveBeenCalled()

    photo.resolve({ ...saved, displayName: renamed, avatarUrl: PHOTO_URL })
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed, avatarUrl: PHOTO_URL })
    expect(await screen.findByText('Профіль оновлено')).toBeInTheDocument()
  })

  it('поля не збереглися — фото не надсилається, вибране лишається', async () => {
    patchAnswer = () =>
      Promise.reject(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Недоступно' }))
    await changeBoth()

    expect(await screen.findByText(/Не вдалося зберегти\. Перевірте з’єднання/)).toBeInTheDocument()
    expect(photoRequests()).toEqual([])
    expect(sessionUser()).toEqual(saved)
    expect(screen.getByRole('button', { name: 'Видалити фото' })).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it('поля збереглися, фото — ні: поля в сесії, форма відкрита, повтор надсилає лише фото', async () => {
    let attempts = 0

    avatarAnswer = () => {
      attempts += 1
      if (attempts === 1) {
        return Promise.reject(
          new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Недоступно' }),
        )
      }

      stored = { ...stored, avatarUrl: PHOTO_URL }

      return Promise.resolve(stored)
    }
    const user = await changeBoth()

    expect(await screen.findByRole('alert')).toHaveTextContent('Недоступно')
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed })
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.queryByText('Профіль оновлено')).not.toBeInTheDocument()

    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ displayName: renamed }])
    expect(requests('/me/avatar', 'POST')).toHaveLength(2)
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed, avatarUrl: PHOTO_URL })
  })

  /** «Зберегти» after the fields were saved and the photo was not: the form starts from the saved fields. */
  async function saveFieldsNotPhoto() {
    avatarAnswer = () =>
      Promise.reject(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Недоступно' }))
    const user = await changeBoth()

    expect(await screen.findByRole('alert')).toHaveTextContent('Недоступно')
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed })

    return user
  }

  it('після часткового збереження зміни рахуються від збережених полів: ім’я назад — це зміна', async () => {
    const user = await saveFieldsNotPhoto()

    await user.click(screen.getByRole('button', { name: 'Видалити фото' }))
    await user.clear(screen.getByRole('textbox', { name: 'Ім’я' }))
    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), saved.displayName)

    expect(saveButton()).toBeEnabled()

    avatarAnswer = undefined
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ displayName: renamed }, { displayName: saved.displayName }])
    expect(requests('/me/avatar', 'POST')).toHaveLength(1)
    expect(sessionUser()).toEqual(saved)
  })

  it('після часткового збереження без фото змін немає: «Зберегти» неактивна, «Скасувати» не питає', async () => {
    const user = await saveFieldsNotPhoto()

    await user.click(screen.getByRole('button', { name: 'Видалити фото' }))

    expect(saveButton()).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(mockReplace).toHaveBeenCalledWith('/profile')
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed })
  })
})

/**
 * A photo request that never answers: `AbortSignal.timeout` is the test's own controller, so the test
 * decides when the save's time is up. A timeout proves nothing about the server: the draft stays for
 * a retry by hand, and nothing is retried on its own.
 */
describe('/profile/edit: фото без відповіді', () => {
  let timeouts: { ms: number; controller: AbortController }[]

  beforeEach(() => {
    timeouts = []
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()

      timeouts.push({ ms, controller })

      return controller.signal
    })
    // Pending until its signal is aborted, as `fetch` is.
    avatarAnswer = (_method, signal) =>
      new Promise((_done, fail) => {
        signal?.addEventListener('abort', () => {
          fail(signal.reason)
        })
      })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  /** The photo request's own time limit runs out. */
  async function timeOut(request: RequestOptions | undefined) {
    const timeout = timeouts.find(({ controller }) => controller.signal === request?.signal)

    expect(timeout?.ms).toBe(SAVE_TIMEOUT_MS)
    await act(async () => {
      timeout?.controller.abort(new DOMException('signal timed out', 'TimeoutError'))
      await Promise.resolve()
    })
  }

  it('завантаження: після таймауту форма розблокована, поля збережені, фото лишається для повтору', async () => {
    const user = await renderEdit()
    const photo = photoFile()

    await user.upload(screen.getByLabelText('Фото профілю'), photo)
    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())

    await waitFor(() => {
      expect(requests('/me/avatar', 'POST')).toHaveLength(1)
    })
    expect(screen.getByRole('button', { name: 'Зберігаємо…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()

    await timeOut(requests('/me/avatar', 'POST')[0])

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервер не відповів вчасно — невідомо, чи збереглося фото. Натисніть «Зберегти», щоб спробувати ще раз.',
    )
    expect(saveButton()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Видалити фото' })).toBeInTheDocument()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(sessionUser()).toEqual({ ...saved, displayName: 'Марта К' })
    expect(mockReplace).not.toHaveBeenCalled()
    expect(screen.queryByText('Профіль оновлено')).not.toBeInTheDocument()
    // Nothing is sent again on its own.
    expect(requests('/me/avatar', 'POST')).toHaveLength(1)

    avatarAnswer = undefined
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(patches()).toEqual([{ displayName: 'Марта К' }])
    expect(requests('/me/avatar', 'POST').map((options) => options.body)).toEqual([photo, photo])
    expect(sessionUser()).toEqual({ ...saved, displayName: 'Марта К', avatarUrl: PHOTO_URL })
  })

  it('видалення: після таймауту форма розблокована, намір видалити лишається для повтору', async () => {
    stored = { ...saved, avatarUrl: PHOTO_URL }
    const user = await renderEdit()

    await user.click(screen.getByRole('button', { name: 'Видалити фото' }))
    expect(requests('/me/avatar', 'DELETE')).toEqual([])
    await user.click(saveButton())

    await waitFor(() => {
      expect(requests('/me/avatar', 'DELETE')).toHaveLength(1)
    })
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()

    await timeOut(requests('/me/avatar', 'DELETE')[0])

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сервер не відповів вчасно — невідомо, чи видалилося фото. Натисніть «Зберегти», щоб спробувати ще раз.',
    )
    expect(saveButton()).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Видалити фото' })).not.toBeInTheDocument()
    expect(sessionUser().avatarUrl).toBe(PHOTO_URL)
    expect(mockReplace).not.toHaveBeenCalled()
    expect(requests('/me/avatar', 'DELETE')).toHaveLength(1)

    avatarAnswer = undefined
    await user.click(saveButton())

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(requests('/me/avatar', 'DELETE')).toHaveLength(2)
    expect(sessionUser().avatarUrl).toBeNull()
  })
})

/**
 * The form and the settings each answer with the whole profile, and their answers may land in any
 * order. Each answer below is what a real server could send: formed before the other request was
 * applied, so it carries the other field's OLD value. Only the fields a request changed may reach
 * the session.
 */
describe('/profile/edit: паралельні запити', () => {
  const renamed = 'Марта К'

  async function startFormAndSetting() {
    const form = deferred<Me>()
    const setting = deferred<Me>()

    patchAnswer = (body) => ('displayName' in body ? form.promise : setting.promise)
    const user = await renderEdit()

    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())
    await screen.findByRole('button', { name: 'Зберігаємо…' })

    const pause = screen.getByRole('switch', { name: 'Пауза для запитів' })

    await user.click(pause)
    expect(patches()).toEqual([{ displayName: renamed }, { loanRequestsPaused: true }])

    return { form, setting, pause }
  }

  it('налаштування змінили під час збереження форми: обидві зміни в сесії за будь-якого порядку', async () => {
    const { form, setting, pause } = await startFormAndSetting()

    // The setting was applied first, so the form's answer already has it; the setting's — the old name.
    form.resolve({ ...saved, displayName: renamed, loanRequestsPaused: true })
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    setting.resolve({ ...saved, loanRequestsPaused: true })

    await waitFor(() => {
      expect(pause).toBeEnabled()
    })
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed, loanRequestsPaused: true })
    expect(pause).toBeChecked()
  })

  it('налаштування відповідає першим, форма — зі старим налаштуванням: пауза лишається', async () => {
    const { form, setting, pause } = await startFormAndSetting()

    setting.resolve({ ...saved, loanRequestsPaused: true })
    await waitFor(() => {
      expect(pause).toBeEnabled()
    })
    form.resolve({ ...saved, displayName: renamed })

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith('/profile')
    })
    expect(sessionUser()).toEqual({ ...saved, displayName: renamed, loanRequestsPaused: true })
    expect(pause).toBeChecked()
  })

  it('збій одного запиту не чіпає іншого: форма не зберіглася, налаштування — так', async () => {
    const { form, setting, pause } = await startFormAndSetting()

    setting.resolve({ ...saved, loanRequestsPaused: true })
    form.reject(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Недоступно' }))

    expect(await screen.findByText(/Не вдалося зберегти\. Перевірте з’єднання/)).toBeInTheDocument()
    expect(sessionUser()).toEqual({ ...saved, loanRequestsPaused: true })
    expect(pause).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Ім’я' })).toHaveValue(renamed)
    expect(mockReplace).not.toHaveBeenCalled()
  })
})

/**
 * A logout or another account's login while the form and a setting are in flight and a photo removal
 * waits for the form. The answers that land afterwards are about the old account: none of them may
 * change the session, the form that is gone shows no toast and leads nowhere, and its photo removal
 * is never sent — it would reach whoever is signed in now.
 */
describe('/profile/edit: сесія змінилася до відповіді', () => {
  async function startEverything() {
    const photo = deferred<Me>()
    const form = deferred<Me>()
    const setting = deferred<Me>()

    stored = { ...saved, avatarUrl: PHOTO_URL }
    avatarAnswer = () => photo.promise
    patchAnswer = (body) => ('displayName' in body ? form.promise : setting.promise)
    const user = await renderEdit()

    await user.click(screen.getByRole('button', { name: 'Видалити фото' }))
    await user.click(screen.getByRole('switch', { name: 'Пауза для запитів' }))
    await user.type(screen.getByRole('textbox', { name: 'Ім’я' }), ' К')
    await user.click(saveButton())
    await screen.findByRole('button', { name: 'Зберігаємо…' })
    expect(requests('/me/avatar', 'DELETE')).toEqual([])
    expect(patches()).toEqual([{ loanRequestsPaused: true }, { displayName: 'Марта К' }])

    const old = stored
    const answerAll = async () => {
      await act(async () => {
        photo.resolve({ ...old, avatarUrl: null })
        setting.resolve({ ...old, loanRequestsPaused: true })
        form.resolve({ ...old, displayName: 'Марта К' })
        await Promise.all([photo.promise, setting.promise, form.promise])
      })
      // The mutations' own callbacks run a tick after the answers.
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0))
      })
    }

    return { user, answerAll }
  }

  it('вихід з акаунта: відповіді не повертають користувача в сесію', async () => {
    const { user, answerAll } = await startEverything()

    await user.click(screen.getByRole('button', { name: 'Вийти з акаунта' }))
    expect(sessionStatus()).toBe('guest')

    await answerAll()

    expect(sessionStatus()).toBe('guest')
    expect(screen.getByText('Потрібен вхід. Переадресовую…')).toBeInTheDocument()
    expect(screen.queryByText('Профіль оновлено')).not.toBeInTheDocument()
    expect(mockReplace.mock.calls).toEqual([['/login?returnTo=%2Fprofile%2Fedit']])
    expect(requests('/me/avatar', 'DELETE')).toEqual([])
  })

  it('вхід в інший акаунт: відповіді для старого не змінюють нову сесію', async () => {
    const { user, answerAll } = await startEverything()

    await user.click(screen.getByRole('button', { name: 'Увійти як Оксана' }))
    expect(await screen.findByRole('textbox', { name: 'Ім’я' })).toHaveValue('Оксана')

    await answerAll()

    expect(sessionUser()).toEqual(oksana)
    expect(screen.getByRole('textbox', { name: 'Ім’я' })).toHaveValue('Оксана')
    expect(screen.getByRole('switch', { name: 'Пауза для запитів' })).not.toBeChecked()
    expect(screen.queryByText('Профіль оновлено')).not.toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
    expect(requests('/me/avatar', 'DELETE')).toEqual([])
  })
})
