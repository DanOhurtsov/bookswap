/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { API_ERROR_CODES, LOAN_LIMITS, type ApiErrorCode, type NetworkCopy } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { NetworkCopyActions } from './NetworkCopyActions'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const copy: NetworkCopy = {
  id: 'c-1',
  editionId: 'e-1',
  translationId: null,
  status: 'AVAILABLE',
  expectedReturnAt: null,
  canRequest: true,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** The local calendar day `days` from today, as the term field counts it. */
function dayIn(days: number): string {
  const at = new Date(Date.now() + days * DAY_MS)

  return [
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('-')
}

/** «2026-11-15» → «15.11.26», as the form writes a date. */
function shortDate(day: string): string {
  const [year = '', month = '', date = ''] = day.split('-')

  return `${date}.${month}.${year.slice(2)}`
}

/** A promise the test settles itself: the request stays «on its way» until then. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })

  return { promise, resolve }
}

/** The viewport, as `matchMedia` tells it: from 48rem the form fits under the copy. */
let isWide = true
const widthListeners = new Set<() => void>()

function setWide(next: boolean): void {
  isWide = next
  act(() => {
    widthListeners.forEach((notify) => {
      notify()
    })
  })
}

beforeAll(() => {
  window.matchMedia = (media: string) =>
    ({
      get matches() {
        return isWide
      },
      media,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_type: string, notify: () => void) => {
        widthListeners.add(notify)
      },
      removeEventListener: (_type: string, notify: () => void) => {
        widthListeners.delete(notify)
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
})

const renderCopy = (
  over: Partial<NetworkCopy>,
  relation: 'FRIEND' | 'OTHER' | 'SELF' = 'FRIEND',
  onRequested: jest.Mock = jest.fn(() => Promise.resolve()),
) => {
  const view = render(
    <ul>
      <NetworkCopyActions
        copy={{ ...copy, ...over }}
        ownerName="Олена"
        relation={relation}
        bookTitle="Дюна"
        onRequested={onRequested}
      />
    </ul>,
  )

  return { ...view, onRequested }
}

const posts = () => apiRequest.mock.calls.filter(([path]) => path === '/loans')
const sendButton = () => screen.getByRole('button', { name: 'Надіслати запит' })
const noteField = () => screen.getByRole('textbox', { name: /Повідомлення власнику/ })
const summary = () => screen.getByRole('group', { name: 'Повернути до' })

async function openForm() {
  await userEvent.click(screen.getByRole('button', { name: 'Попросити' }))
}

beforeEach(() => {
  jest.clearAllMocks()
  isWide = true
  apiRequest.mockResolvedValue({ loan: { id: 'loan-new' } })
})

describe('NetworkCopyActions', () => {
  it('canRequest false: no request form, plain explanation', () => {
    renderCopy({ canRequest: false })

    expect(screen.queryByRole('button', { name: 'Попросити' })).not.toBeInTheDocument()
    expect(screen.getByText('Зараз попросити не можна.')).toBeInTheDocument()
  })

  it('shows status and the expected return date for a lent copy', () => {
    renderCopy({ status: 'LENT_OUT', canRequest: false, expectedReturnAt: '2026-12-31' })

    expect(
      screen.getByText(/У позичальника · орієнтовно вільна 31 грудня 2026/),
    ).toBeInTheDocument()
  })

  it('stranger owner: keeps the «add as a friend first» hint', () => {
    renderCopy({ canRequest: false }, 'OTHER')

    expect(screen.getByRole('link', { name: 'Спочатку додайте власника в друзі' })).toHaveAttribute(
      'href',
      '/friends',
    )
  })

  it('own copy is labelled, without actions', () => {
    renderCopy({ canRequest: false }, 'SELF')

    expect(screen.getByText('Ваш примірник.')).toBeInTheDocument()
  })
})

describe('NetworkCopyActions: «Попросити» opens the shelf’s request form', () => {
  it('under the copy: «Без дати» chosen; an untouched form sends only the copy', async () => {
    renderCopy({})
    await openForm()

    expect(screen.getByRole('region', { name: 'Новий запит' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /^Без дати/ })).toBeChecked()

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toEqual([
      ['/loans', expect.objectContaining({ method: 'POST', body: { copyId: 'c-1' } })],
    ])
  })

  it('a preset and a note go into the same body as before; the counter follows the contract', async () => {
    renderCopy({})
    await openForm()

    await userEvent.click(screen.getByRole('radio', { name: /^3 тижні/ }))
    await userEvent.type(noteField(), '  Дякую!  ')

    expect(noteField()).toHaveAccessibleDescription(`10/${LOAN_LIMITS.messageMax}`)
    expect(noteField()).toHaveAttribute('maxLength', String(LOAN_LIMITS.messageMax))
    expect(summary()).toHaveTextContent(shortDate(dayIn(21)))

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toEqual([
      [
        '/loans',
        expect.objectContaining({
          method: 'POST',
          body: { copyId: 'c-1', message: 'Дякую!', proposedDueAt: dayIn(21) },
        }),
      ],
    ])
  })

  it('while sending: one POST however often it is pressed; the list is read again only after the answer', async () => {
    const answer = deferred<{ loan: { id: string } }>()

    apiRequest.mockReturnValue(answer.promise)

    const { onRequested } = renderCopy({})

    await openForm()
    await userEvent.click(sendButton())

    const busy = screen.getByRole('button', { name: 'Надсилаю…' })

    await userEvent.click(busy)
    await userEvent.keyboard('{Enter}')

    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveFocus()
    expect(noteField()).toBeDisabled()
    expect(posts()).toHaveLength(1)
    expect(onRequested).not.toHaveBeenCalled()

    answer.resolve({ loan: { id: 'loan-new' } })

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(posts()).toHaveLength(1)
    expect(onRequested).toHaveBeenCalledTimes(1)
  })

  it('«Запит надіслано» takes the focus and opens that very request; «Закрити» gives the focus back', async () => {
    renderCopy({})
    await openForm()
    await userEvent.click(sendButton())

    const title = await screen.findByRole('heading', { name: 'Запит надіслано' })

    expect(title).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Олена отримає сповіщення і зможе погодити запит, змінивши дату, або відмовити.',
    )
    expect(screen.getByRole('link', { name: 'Відкрити запит' })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-new&role=borrower',
    )

    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))

    expect(screen.getByRole('button', { name: 'Попросити' })).toHaveFocus()
  })

  it('the outcome outlives the re-read list; once closed, the focus lands on the copy’s own line', async () => {
    const view = renderCopy({})

    await openForm()
    await userEvent.click(sendButton())
    await screen.findByRole('heading', { name: 'Запит надіслано' })

    // The list, read again: the copy cannot be asked for a second time.
    view.rerender(
      <ul>
        <NetworkCopyActions
          copy={{ ...copy, canRequest: false }}
          ownerName="Олена"
          relation="FRIEND"
          bookTitle="Дюна"
          onRequested={view.onRequested}
        />
      </ul>,
    )

    expect(screen.getByRole('heading', { name: 'Запит надіслано' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Закрити' }))

    expect(screen.queryByRole('button', { name: 'Попросити' })).not.toBeInTheDocument()
    expect(screen.getByText('Вдома, вільна')).toHaveFocus()
  })

  it('a failed send keeps the date and the message; a retry sends them again', async () => {
    apiRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const { onRequested } = renderCopy({})

    await openForm()
    await userEvent.click(screen.getByRole('radio', { name: /^Тиждень/ }))
    await userEvent.type(noteField(), 'Привіт')
    await userEvent.click(sendButton())

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не вдалося надіслати запит. Перевірте зʼєднання і спробуйте ще раз. Дата й повідомлення збережені.',
    )
    expect(noteField()).toHaveValue('Привіт')
    expect(summary()).toHaveTextContent(shortDate(dayIn(7)))
    expect(sendButton()).toHaveFocus()
    expect(onRequested).not.toHaveBeenCalled()

    await userEvent.click(sendButton())

    await screen.findByRole('heading', { name: 'Запит надіслано' })

    const body = { copyId: 'c-1', message: 'Привіт', proposedDueAt: dayIn(7) }

    expect(posts()).toEqual([
      ['/loans', expect.objectContaining({ method: 'POST', body })],
      ['/loans', expect.objectContaining({ method: 'POST', body })],
    ])
  })

  it.each<[ApiErrorCode, string, string]>([
    [
      API_ERROR_CODES.LOAN_DUPLICATE_REQUEST,
      'Запит уже надіслано',
      'Ви вже просили цю книжку, і власник ще не відповів — новий запит не потрібен.',
    ],
    [
      API_ERROR_CODES.LOAN_COPY_UNAVAILABLE,
      'Книжку зараз не можна попросити',
      'Поки ви заповнювали запит, примірник став недоступним.',
    ],
    [
      API_ERROR_CODES.LOAN_REQUESTS_PAUSED,
      'Власник зараз не приймає запитів',
      'Олена тимчасово не приймає запитів на позичання. Спробуйте пізніше.',
    ],
  ])('409 %s: «%s», the list is read again, nothing to open', async (code, title, text) => {
    apiRequest.mockRejectedValueOnce(new ApiRequestError(409, { code, message: 'Конфлікт' }))

    const { onRequested } = renderCopy({})

    await openForm()
    await userEvent.click(sendButton())

    expect(await screen.findByRole('heading', { name: title })).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(text)
    // The list carries no loan of the viewer's own: there is no request here to link to.
    expect(screen.queryByRole('link', { name: 'Відкрити запит' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onRequested).toHaveBeenCalledTimes(1)
    expect(posts()).toHaveLength(1)
  })

  it('«Скасувати» closes without a request, and the focus returns to «Попросити»', async () => {
    renderCopy({})
    await openForm()
    await userEvent.type(noteField(), 'Чернетка')
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(screen.queryByRole('region', { name: 'Новий запит' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Попросити' })).toHaveFocus()
    expect(posts()).toHaveLength(0)
  })
})

describe('NetworkCopyActions: a phone gets the bottom sheet', () => {
  it('narrower than 48rem: the dialog «Попросити книжку» names the book; Escape closes it and the focus returns', async () => {
    isWide = false
    renderCopy({})
    await openForm()

    const sheet = screen.getByRole('dialog', { name: 'Попросити книжку' })

    expect(sheet).toHaveAccessibleDescription('Дюна')
    expect(within(sheet).getByRole('button', { name: 'Надіслати запит' })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: 'Попросити' })).toHaveFocus()
    expect(posts()).toHaveLength(0)
  })

  it('crossing 48rem both ways keeps the note, the date and the failure', async () => {
    apiRequest.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderCopy({})
    await openForm()

    await userEvent.click(screen.getByRole('radio', { name: /^2 тижні/ }))
    await userEvent.type(noteField(), 'Привіт')
    await userEvent.click(sendButton())
    await screen.findByRole('alert')

    const kept = () => {
      expect(noteField()).toHaveValue('Привіт')
      expect(summary()).toHaveTextContent(shortDate(dayIn(14)))
      expect(screen.getByRole('alert')).toHaveTextContent('Не вдалося надіслати запит.')
    }

    setWide(false)
    expect(screen.getByRole('dialog', { name: 'Попросити книжку' })).toBeInTheDocument()
    kept()

    setWide(true)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    kept()
  })
})

describe('NetworkCopyActions: how a settled request is told to the list (issue #87)', () => {
  const unavailable = () =>
    apiRequest.mockRejectedValueOnce(
      new ApiRequestError(409, { code: 'LOAN_COPY_UNAVAILABLE', message: 'Конфлікт' }),
    )

  /** The copy, with `onOutcomeClosed` as `/catalog` passes it. */
  function renderListed() {
    const onRequested = jest.fn((_outcome: unknown) => Promise.resolve())
    const onOutcomeClosed = jest.fn()
    const element = (over: Partial<NetworkCopy> = {}) => (
      <ul>
        <NetworkCopyActions
          copy={{ ...copy, ...over }}
          ownerName="Олена"
          relation="FRIEND"
          bookTitle="Дюна"
          onRequested={onRequested}
          onOutcomeClosed={onOutcomeClosed}
        />
      </ul>
    )
    const view = render(element())

    return { ...view, element, onRequested, onOutcomeClosed }
  }

  /** The outcome's own «Закрити» — the phone's sheet has a ✕ of the same name. */
  const closeOutcome = () =>
    within(screen.getByRole('status')).getByRole('button', { name: 'Закрити' })

  it('each outcome is named to the list, at once and once more when it is closed', async () => {
    const { onRequested, onOutcomeClosed } = renderListed()

    await openForm()
    await userEvent.click(sendButton())
    await screen.findByRole('heading', { name: 'Запит надіслано' })

    expect(onRequested).toHaveBeenCalledWith('sent')
    expect(onOutcomeClosed).not.toHaveBeenCalled()

    await userEvent.click(closeOutcome())

    expect(onOutcomeClosed).toHaveBeenCalledTimes(1)
    expect(onOutcomeClosed).toHaveBeenCalledWith('sent')
  })

  it('«Скасувати» on a draft is no outcome: nothing is said to the list', async () => {
    const { onRequested, onOutcomeClosed } = renderListed()

    await openForm()
    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))

    expect(onRequested).not.toHaveBeenCalled()
    expect(onOutcomeClosed).not.toHaveBeenCalled()
  })

  it('LOAN_COPY_UNAVAILABLE: no second send — «Попросити» stays gone over the list it was refused from, until the list is read again', async () => {
    unavailable()

    const { element, rerender, onRequested, onOutcomeClosed } = renderListed()

    await openForm()
    await userEvent.click(sendButton())
    await screen.findByRole('heading', { name: 'Книжку зараз не можна попросити' })

    expect(onRequested).toHaveBeenCalledWith('unavailable')
    // The explanation replaces the form: nothing to send from.
    expect(screen.queryByRole('button', { name: 'Надіслати запит' })).not.toBeInTheDocument()

    await userEvent.click(closeOutcome())

    expect(onOutcomeClosed).toHaveBeenCalledWith('unavailable')
    // The list has not been read again: it still says `canRequest`, the server said otherwise.
    expect(screen.queryByRole('button', { name: 'Попросити' })).not.toBeInTheDocument()
    expect(screen.getByText('Зараз попросити не можна.')).toBeInTheDocument()
    expect(screen.getByText('Вдома, вільна')).toHaveFocus()
    expect(posts()).toHaveLength(1)

    // Read again, and the copy can be asked for after all: the fresh list decides.
    rerender(element())

    expect(screen.getByRole('button', { name: 'Попросити' })).toBeInTheDocument()
  })

  it.each([
    ['its «Закрити»', () => userEvent.click(closeOutcome())],
    ['Escape', () => userEvent.keyboard('{Escape}')],
    [
      'the sheet’s ✕',
      () =>
        userEvent.click(
          within(screen.getByRole('dialog'))
            .getAllByRole('button', { name: 'Закрити' })
            .find((button) => screen.getByRole('status').contains(button) === false)!,
        ),
    ],
  ])('in the phone’s sheet, closing the outcome by %s tells the list', async (_, close) => {
    isWide = false
    unavailable()

    const { onOutcomeClosed } = renderListed()

    await openForm()
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Надіслати запит' }),
    )
    await screen.findByRole('heading', { name: 'Книжку зараз не можна попросити' })
    expect(onOutcomeClosed).not.toHaveBeenCalled()

    await close()

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(onOutcomeClosed).toHaveBeenCalledTimes(1)
    expect(onOutcomeClosed).toHaveBeenCalledWith('unavailable')
    expect(screen.getByText('Вдома, вільна')).toHaveFocus()
  })
})
