/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan, Me } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import type { SessionState } from '@/app/lib/use-session'
import { initialDueDate } from '../model/approve-due-date'
import { IncomingRequests } from './IncomingRequests'

/**
 * BS-147: «Потребує вашої дії» by role, label and text. `apiRequest` and the session are replaced; an
 * account change with the real `SessionProvider` and `Providers` is in
 * `IncomingRequests.account-switch.spec`. jsdom lays nothing out, so the rail, the rows and the grid
 * are checked in the browser (`home-incoming-requests.browser-spec`).
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

let session: SessionState

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({ state: session }),
}))

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const LIST_PATH = '/loans?role=owner&status=REQUESTED'
const SECTION = 'Потребує вашої дії'

function me(overrides: Partial<Me> = {}): Me {
  return {
    id: 'me',
    email: 'me@example.com',
    emailVerified: true,
    displayName: 'Данило',
    handle: 'me',
    city: null,
    avatarUrl: null,
    bio: null,
    libraryVisibility: 'FRIENDS',
    showHolderNames: false,
    friendsOfFriendsAccess: false,
    loanRequestsPaused: false,
    defaultLoanTermDays: null,
    ownerDueReminders: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function request(id: string, title: string, overrides: Partial<Loan> = {}): Loan {
  return {
    id,
    status: 'REQUESTED',
    isOverdue: false,
    message: null,
    responseNote: null,
    origin: 'REQUESTED',
    // Two hours ago: the relative wording itself is the model's spec.
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000).toISOString(),
    requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000 - 60_000).toISOString(),
    respondedAt: null,
    handedAt: null,
    returnedAt: null,
    dueAt: null,
    owner: { id: 'me', displayName: 'Данило', handle: 'me', avatarUrl: null },
    borrower: { id: `b-${id}`, displayName: 'Ірина', handle: `iryna-${id}`, avatarUrl: null },
    copy: { id: `copy-${id}`, status: 'AVAILABLE', condition: 'GOOD', isArchived: false },
    edition: {
      id: `ed-${id}`,
      workId: `work-${id}`,
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
      id: `work-${id}`,
      title,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [
      { id: 'a-1', name: 'Михайло Булгаков', nameLatin: null, role: 'AUTHOR', position: 0 },
    ],
    recovery: null,
    ...overrides,
  }
}

/** A tiny server: the list of requests, and an answer that takes the request off it. */
let requests: Loan[]
let answer: (id: string) => Promise<unknown>

function serve(): void {
  apiRequest.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === LIST_PATH) return Promise.resolve({ loans: [...requests] })
    if (options?.method === 'PATCH') return answer(path.replace('/loans/', ''))

    throw new Error(`Unexpected request: ${path}`)
  })
}

function answeredBy(id: string): Promise<unknown> {
  const loan = requests.find((each) => each.id === id)

  requests = requests.filter((each) => each.id !== id)

  return Promise.resolve({ loan })
}

const listReads = () => apiRequest.mock.calls.filter(([path]) => path === LIST_PATH)
const patches = () => apiRequest.mock.calls.filter(([, options]) => options?.method === 'PATCH')

const section = () => screen.getByRole('region', { name: SECTION })
const card = (title: string) => screen.getByRole('article', { name: title })

function renderSection() {
  return render(withQueryClient(<IncomingRequests />))
}

beforeEach(() => {
  apiRequest.mockReset()
  session = { status: 'authenticated', user: me() } as SessionState
  requests = []
  answer = answeredBy
  serve()
})

describe('IncomingRequests (BS-147)', () => {
  it.each<[string, SessionState]>([
    ['a guest', { status: 'guest' }],
    ['a session still loading', { status: 'loading' }],
    ['a failed session', { status: 'error', message: 'Збій' }],
  ])('for %s there is no section and no request', (_name, state) => {
    session = state

    renderSection()

    expect(screen.queryByRole('region', { name: SECTION })).not.toBeInTheDocument()
    expect(apiRequest).not.toHaveBeenCalled()
  })

  it('asks for the requests on my books once, and links to all of them on /loans', async () => {
    renderSection()

    expect(await screen.findByRole('heading', { level: 2, name: SECTION })).toBeInTheDocument()
    expect(within(section()).getByRole('link', { name: 'Переглянути всі' })).toHaveAttribute(
      'href',
      '/loans?role=owner',
    )
    expect(screen.getByText('Усі')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => {
      expect(listReads()).toHaveLength(1)
    })
  })

  it('says it is loading while the first answer is on its way', () => {
    apiRequest.mockReturnValue(new Promise(() => undefined))

    renderSection()

    expect(within(section()).getByText('Шукаю запити на ваші книжки…')).toBeInTheDocument()
    expect(section()).toHaveAttribute('aria-busy', 'true')
  })

  it('shows an error with a manual retry, does not retry on its own, and recovers on retry', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Майстер і Маргарита')]
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    )

    renderSection()

    expect(await within(section()).findByRole('alert')).toHaveTextContent(
      'Не вдалося завантажити запити на ваші книжки. Сервер недоступний',
    )
    expect(listReads()).toHaveLength(1)

    await user.click(within(section()).getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('article', { name: 'Майстер і Маргарита' })).toBeInTheDocument()
    expect(listReads()).toHaveLength(2)
  })

  it('says everything is answered when nobody asks for anything, with no count', async () => {
    renderSection()

    expect(await within(section()).findByText('Усе опрацьовано')).toBeInTheDocument()
    expect(within(section()).getByText('Нових запитів немає.')).toBeInTheDocument()
    expect(within(section()).queryByText('0 запитів')).not.toBeInTheDocument()
  })

  it('shows the three newest of all the requests, and counts them all', async () => {
    requests = ['П’ятий', 'Четвертий', 'Третій', 'Другий', 'Перший'].map((title, index) =>
      request(String(5 - index), title),
    )

    renderSection()

    await screen.findByRole('article', { name: 'П’ятий' })

    const titles = within(section())
      .getAllByRole('article')
      .map((each) => within(each).getByRole('link').textContent)

    expect(titles).toEqual(['П’ятий', 'Четвертий', 'Третій'])
    expect(within(section()).getByText('5 запитів')).toHaveClass('sr-only')
  })

  it('shows who asks, when, for what, until when, and what they wrote', async () => {
    requests = [
      request('1', 'Майстер і Маргарита', {
        dueAt: '2026-11-15',
        message: 'Давно хотіла перечитати — поверну вчасно!',
      }),
    ]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Майстер і Маргарита' })

    expect(within(article).getByText('Ірина')).toBeInTheDocument()
    expect(within(article).getByText('2 год тому')).toHaveAttribute(
      'dateTime',
      requests[0]?.requestedAt,
    )
    expect(within(article).getByText('Новий запит')).toBeInTheDocument()
    expect(within(article).getByRole('link', { name: 'Майстер і Маргарита' })).toHaveAttribute(
      'href',
      '/loans?loanId=1',
    )
    expect(within(article).getByText('Михайло Булгаков')).toBeInTheDocument()
    expect(within(article).getByText('15.11.26')).toHaveAttribute('dateTime', '2026-11-15')
    expect(within(article).getByText(/Поверне до/)).toHaveTextContent('Поверне до 15.11.26')
    expect(
      within(article).getByText('«Давно хотіла перечитати — поверну вчасно!»'),
    ).toBeInTheDocument()
  })

  it('says nothing of a return date the borrower did not propose, nor of a message they did not write', async () => {
    requests = [request('1', 'Дюна')]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    expect(within(article).queryByText(/Поверне до/)).not.toBeInTheDocument()
    expect(within(article).queryByText(/«/)).not.toBeInTheDocument()
  })
})

describe('IncomingRequests: answering (BS-147)', () => {
  it('«Погодити» opens the /loans approval form in the card, with the focus in its date', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Майстер і Маргарита', { dueAt: '2026-11-15' })]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Майстер і Маргарита' })
    const approve = within(article).getByRole('button', { name: 'Погодити' })

    expect(approve).toHaveAttribute('aria-expanded', 'false')
    expect(within(article).queryByLabelText('Повернути до')).not.toBeInTheDocument()

    await user.click(approve)

    const due = within(article).getByLabelText('Повернути до')

    expect(due).toHaveValue('2026-11-15')
    expect(due).toHaveFocus()
    expect(due).toHaveAccessibleDescription('Позичальник просив саме цю дату.')
    expect(within(article).getByLabelText('Відповідь')).toHaveValue('')
    expect(patches()).toHaveLength(0)
  })

  it('without a proposed date the form starts from the owner’s term, as on /loans', async () => {
    const user = userEvent.setup()

    session = { status: 'authenticated', user: me({ defaultLoanTermDays: 21 }) } as SessionState
    requests = [request('1', 'Дюна')]

    renderSection()

    await user.click(
      within(await screen.findByRole('article', { name: 'Дюна' })).getByRole('button', {
        name: 'Погодити',
      }),
    )

    expect(screen.getByLabelText('Повернути до')).toHaveValue(initialDueDate(null, 21, new Date()))
  })

  it('approves with the date and the answer, reads the list again, and the card leaves', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Майстер і Маргарита'), request('2', 'Дюна')]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Майстер і Маргарита' })

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.clear(within(article).getByLabelText('Повернути до'))
    await user.type(within(article).getByLabelText('Повернути до'), '2026-11-20')
    await user.type(within(article).getByLabelText('Відповідь'), 'Забирай у суботу')
    await user.click(within(article).getByRole('button', { name: 'Погодити' }))

    expect(apiRequest).toHaveBeenCalledWith('/loans/1', {
      method: 'PATCH',
      body: { action: 'approve', dueAt: '2026-11-20', note: 'Забирай у суботу' },
    })
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'Майстер і Маргарита' })).not.toBeInTheDocument()
    })
    expect(card('Дюна')).toBeInTheDocument()
    expect(listReads()).toHaveLength(2)
    expect(within(section()).getByRole('status')).toHaveTextContent(
      'Запит на «Майстер і Маргарита» погоджено.',
    )
    expect(screen.getByRole('heading', { level: 2, name: SECTION })).toHaveFocus()
  })

  it('Enter in the answer sends the approval too', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.type(within(article).getByLabelText('Відповідь'), 'Так{Enter}')

    expect(apiRequest).toHaveBeenCalledWith('/loans/1', {
      method: 'PATCH',
      body: { action: 'approve', note: 'Так' },
    })
  })

  it('while the approval is sent, says so and lets neither answer be pressed again', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]
    answer = () => new Promise(() => undefined)

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.click(within(article).getByRole('button', { name: 'Погодити' }))

    expect(within(article).getByRole('button', { name: 'Погоджуємо…' })).toBeDisabled()
    expect(within(article).getByRole('button', { name: 'Скасувати' })).toBeDisabled()
    expect(article).toHaveAttribute('aria-busy', 'true')
    expect(patches()).toHaveLength(1)
  })

  it('«Скасувати» and Escape close the form without answering, and the focus returns to «Погодити»', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.click(within(article).getByRole('button', { name: 'Скасувати' }))

    expect(within(article).queryByLabelText('Повернути до')).not.toBeInTheDocument()
    expect(within(article).getByRole('button', { name: 'Погодити' })).toHaveFocus()

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.keyboard('{Escape}')

    expect(within(article).queryByLabelText('Повернути до')).not.toBeInTheDocument()
    expect(within(article).getByRole('button', { name: 'Погодити' })).toHaveFocus()
    expect(within(article).getByRole('button', { name: 'Відмовити' })).toBeEnabled()
    expect(patches()).toHaveLength(0)
  })

  it('«Відмовити» rejects at once, as on /loans, and the card leaves', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]

    renderSection()

    await user.click(
      within(await screen.findByRole('article', { name: 'Дюна' })).getByRole('button', {
        name: 'Відмовити',
      }),
    )

    expect(apiRequest).toHaveBeenCalledWith('/loans/1', {
      method: 'PATCH',
      body: { action: 'reject' },
    })
    expect(await within(section()).findByText('Усе опрацьовано')).toBeInTheDocument()
    expect(within(section()).getByRole('status')).toHaveTextContent('Запит на «Дюна» відхилено.')
  })

  it('while the rejection is sent, neither answer can be pressed', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]
    answer = () => new Promise(() => undefined)

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    await user.click(within(article).getByRole('button', { name: 'Відмовити' }))

    expect(within(article).getByRole('button', { name: 'Відмовити' })).toBeDisabled()
    expect(within(article).getByRole('button', { name: 'Погодити' })).toBeDisabled()
  })

  it('a request already answered elsewhere: 409, the list is read once again, the stale card goes, the count follows, and the explanation stays', async () => {
    const user = userEvent.setup()

    requests = [
      request('4', 'Майстер і Маргарита'),
      request('3', 'Дюна'),
      request('2', 'Тигролови'),
      request('1', 'Земля'),
    ]
    // Answered in another tab: the server has taken it off the list, and this answer is too late.
    answer = (id) => {
      requests = requests.filter((each) => each.id !== id)

      return Promise.reject(conflict())
    }

    renderSection()

    const article = await screen.findByRole('article', { name: 'Майстер і Маргарита' })

    expect(within(section()).getByText('4 запити')).toBeInTheDocument()

    await user.click(within(article).getByRole('button', { name: 'Погодити' }))
    await user.click(within(article).getByRole('button', { name: 'Погодити' }))

    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'Майстер і Маргарита' })).not.toBeInTheDocument()
    })
    expect(within(section()).getByRole('alert')).toHaveTextContent(
      'Не вдалося відповісти на запит на «Майстер і Маргарита». Дія неможлива в поточному стані позичання',
    )
    expect(within(section()).getByText('3 запити')).toBeInTheDocument()
    expect(
      screen.getAllByRole('article').map((each) => each.getAttribute('aria-labelledby')),
    ).toHaveLength(3)
    expect(card('Земля')).toBeInTheDocument()
    expect(within(section()).getByRole('status')).toBeEmptyDOMElement()
    expect(screen.getByRole('heading', { level: 2, name: SECTION })).toHaveFocus()
    expect(patches()).toHaveLength(1)
    expect(listReads()).toHaveLength(2)

    // No loop: nothing reads the list again on its own.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(listReads()).toHaveLength(2)
    expect(patches()).toHaveLength(1)
  })

  it('after a conflict the explanation outlives the last card, and a later success announces nothing stale', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]
    answer = (id) => {
      requests = requests.filter((each) => each.id !== id)

      return Promise.reject(conflict())
    }

    renderSection()

    await user.click(
      within(await screen.findByRole('article', { name: 'Дюна' })).getByRole('button', {
        name: 'Відмовити',
      }),
    )

    expect(await within(section()).findByText('Усе опрацьовано')).toBeInTheDocument()
    expect(within(section()).getByRole('alert')).toHaveTextContent(
      'Не вдалося відповісти на запит на «Дюна».',
    )
    expect(within(section()).getByRole('status')).toBeEmptyDOMElement()
  })

  it('the explanation goes when the next answer is sent', async () => {
    const user = userEvent.setup()

    requests = [request('2', 'Майстер і Маргарита'), request('1', 'Дюна')]
    answer = (id) => {
      requests = requests.filter((each) => each.id !== id)

      return id === '2' ? Promise.reject(conflict()) : Promise.resolve({})
    }

    renderSection()

    await user.click(
      within(await screen.findByRole('article', { name: 'Майстер і Маргарита' })).getByRole(
        'button',
        { name: 'Відмовити' },
      ),
    )
    expect(await within(section()).findByRole('alert')).toBeInTheDocument()

    await user.click(within(card('Дюна')).getByRole('button', { name: 'Відмовити' }))

    expect(await within(section()).findByText('Усе опрацьовано')).toBeInTheDocument()
    expect(within(section()).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(section()).getByRole('status')).toHaveTextContent('Запит на «Дюна» відхилено.')
  })

  it('while the list is read again after a conflict, the stale card cannot be answered', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]
    answer = () => Promise.reject(conflict())

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    apiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === LIST_PATH) return new Promise(() => undefined)
      if (options?.method === 'PATCH') return answer(path.replace('/loans/', ''))

      throw new Error(`Unexpected request: ${path}`)
    })

    await user.click(within(article).getByRole('button', { name: 'Відмовити' }))

    await waitFor(() => {
      expect(listReads()).toHaveLength(2)
    })
    expect(within(article).getByRole('button', { name: 'Відмовити' })).toBeDisabled()
    expect(within(article).getByRole('button', { name: 'Погодити' })).toBeDisabled()
    expect(article).toHaveAttribute('aria-busy', 'true')
  })

  it('when that read fails, the section says so with its manual retry, and reads nothing more', async () => {
    const user = userEvent.setup()

    requests = [request('1', 'Дюна')]
    answer = () => Promise.reject(conflict())

    renderSection()

    const article = await screen.findByRole('article', { name: 'Дюна' })

    apiRequest.mockImplementation((path: string, options?: { method?: string }) => {
      if (path === LIST_PATH) {
        return Promise.reject(
          new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
        )
      }
      if (options?.method === 'PATCH') return answer(path.replace('/loans/', ''))

      throw new Error(`Unexpected request: ${path}`)
    })

    await user.click(within(article).getByRole('button', { name: 'Відмовити' }))

    expect(
      await within(section()).findByText(
        'Не вдалося завантажити запити на ваші книжки. Сервер недоступний',
      ),
    ).toBeInTheDocument()
    expect(within(section()).getByRole('button', { name: 'Спробувати ще раз' })).toBeEnabled()
    expect(
      within(section()).getByText(/Не вдалося відповісти на запит на «Дюна»/),
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(listReads()).toHaveLength(2)
    expect(patches()).toHaveLength(1)
  })

  it.each<[string, () => Error, string?]>([
    [
      'another conflict',
      () =>
        new ApiRequestError(409, {
          code: 'LOAN_COPY_STATE_MISMATCH',
          message: 'Полиця вже не така',
        }),
    ],
    [
      'a server error',
      () => new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Сервер недоступний' }),
    ],
    ['a network failure', () => new TypeError('Failed to fetch'), 'Не вдалося звʼязатися з API'],
  ])(
    '%s is shown on that card only; the card stays and the list is not read again',
    async (_name, failure, shown = failure().message) => {
      const user = userEvent.setup()

      requests = [request('1', 'Майстер і Маргарита'), request('2', 'Дюна')]
      answer = () => Promise.reject(failure())

      renderSection()

      const article = await screen.findByRole('article', { name: 'Майстер і Маргарита' })

      await user.click(within(article).getByRole('button', { name: 'Погодити' }))
      await user.click(within(article).getByRole('button', { name: 'Погодити' }))

      expect(await within(article).findByRole('alert')).toHaveTextContent(shown)
      expect(within(card('Дюна')).queryByRole('alert')).not.toBeInTheDocument()
      expect(within(article).getByRole('button', { name: 'Погодити' })).toBeEnabled()
      expect(listReads()).toHaveLength(1)
      expect(within(section()).getAllByRole('alert')).toHaveLength(1)
      expect(within(section()).getByRole('status')).toBeEmptyDOMElement()
    },
  )
})

function conflict(): ApiRequestError {
  return new ApiRequestError(409, {
    code: 'LOAN_INVALID_TRANSITION',
    message: 'Дія неможлива в поточному стані позичання',
  })
}
