/** @jest-environment jsdom */

import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { ActivationResponse } from '@bookswap/shared'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { ActivationChecklist } from './ActivationChecklist'
import type { ActivationInitialState } from '../model/activation-state'

/**
 * Stage 8h-2, R11: the checklist as people actually see it.
 *
 * The counts below are the ones the plan's DoD names — 0, 1, 9, 10 and beyond —
 * because each of them says something different: nothing yet, a start, almost
 * there, done, and «done, and then some», which is the one that could overflow
 * a progress bar.
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({ useSession: jest.fn() }))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')
const { useSession: mockUseSession } = jest.requireMock<{ useSession: jest.Mock }>(
  '@/app/lib/use-session',
)

type SessionStatus = 'loading' | 'guest' | 'authenticated' | 'error'

function session(status: SessionStatus): void {
  mockUseSession.mockReturnValue({
    state:
      status === 'authenticated'
        ? { status, user: { id: 'user-1' } }
        : status === 'error'
          ? { status, message: 'сесія впала' }
          : { status },
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  })
}

function progress(ownedCopyCount: number): ActivationResponse {
  const hasReachedTarget = ownedCopyCount >= 10

  return {
    ownedCopyCount,
    target: 10,
    hasReachedTarget,
    nextAction: hasReachedTarget ? 'INVITE_FRIENDS' : 'ADD_BOOKS',
  }
}

function renderChecklist(initial?: ActivationInitialState): void {
  render(withQueryClient(<ActivationChecklist initial={initial} />, createTestQueryClient()))
}

const bar = (): HTMLProgressElement => screen.getByRole('progressbar')

beforeEach(() => {
  mockApiRequest.mockReset()
  session('authenticated')
})

describe('кому показується', () => {
  it('гостю не показується взагалі — і жодного запиту не надсилає', () => {
    session('guest')
    const { container } = render(withQueryClient(<ActivationChecklist />, createTestQueryClient()))

    expect(container).toBeEmptyDOMElement()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('поки сесія вантажиться, а сервер уже сказав «гість», нічого не блимає', () => {
    session('loading')
    const { container } = render(
      withQueryClient(
        <ActivationChecklist initial={{ status: 'guest' }} />,
        createTestQueryClient(),
      ),
    )

    expect(container).toBeEmptyDOMElement()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('при зламаній сесії мовчить — про це вже повідомляє сама сторінка', () => {
    session('error')
    const { container } = render(withQueryClient(<ActivationChecklist />, createTestQueryClient()))

    expect(container).toBeEmptyDOMElement()
  })
})

describe('стани завантаження', () => {
  it('без серверного знімка (AddBookSuccess, COMMITTED) сам питає сервер', async () => {
    mockApiRequest.mockResolvedValue(progress(3))

    renderChecklist()

    expect(screen.getByText('Рахую вашу полицю…')).toBeInTheDocument()
    expect(await screen.findByText('3 з 10')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(mockApiRequest).toHaveBeenCalledWith('/me/activation', expect.anything())
  })

  it('серверний знімок рендериться одразу, без запиту з браузера', () => {
    renderChecklist({ status: 'ready', data: progress(4) })

    expect(screen.getByText('4 з 10')).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('серверна помилка не ховає чеклист, але й не питає сама', () => {
    mockApiRequest.mockResolvedValue(progress(2))

    renderChecklist({ status: 'error' })

    // Сервер щойно з'ясував, що прочитати прогрес не вдалося. Мовчки спитати
    // те саме з браузера — це зробити протилежне до того, що він з'ясував.
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('Не вдалося прочитати прогрес.')).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })
})

describe('серверна помилка: нічого не вигадуємо за користувача', () => {
  it('не показує число з кеша як актуальне — ані до повтору, ані під час нього', async () => {
    const client = createTestQueryClient()

    // Хтось уже клав сюди число (інший екран, попередня навігація).
    client.setQueryData(['activation'], progress(5))
    mockApiRequest.mockReturnValue(new Promise(() => undefined))

    render(withQueryClient(<ActivationChecklist initial={{ status: 'error' }} />, client))

    expect(screen.queryByText('5 з 10')).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    // Запит у польоті: старе число не повертається «на час очікування».
    expect(screen.queryByText('5 з 10')).not.toBeInTheDocument()
    expect(screen.getByText('Рахую вашу полицю…')).toBeInTheDocument()
  })

  it('кнопка повтору робить рівно один запит', async () => {
    mockApiRequest.mockResolvedValue(progress(6))

    renderChecklist({ status: 'error' })
    expect(mockApiRequest).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('6 з 10')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(mockApiRequest).toHaveBeenCalledWith('/me/activation', expect.anything())
  })

  it('невдалий повтор повертає помилку, а не порожній чеклист', async () => {
    mockApiRequest.mockRejectedValue(new Error('мережа впала'))

    renderChecklist({ status: 'error' })

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText(/Не вдалося оновити прогрес/)).toBeInTheDocument()
    // `retry: false` лишається: один запит на одне натискання.
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Спробувати ще раз' })).toBeInTheDocument()
  })
})

describe('помилка і ручний повтор', () => {
  it('невдале читання показується як помилка й лагодиться кнопкою', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('мережа впала'))

    renderChecklist()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByText(/Не вдалося оновити прогрес/)).toBeInTheDocument()
    // Один запит, не нескінченна черга повторів.
    expect(mockApiRequest).toHaveBeenCalledTimes(1)

    // Явний повтор — єдине, що повторює невдале читання.
    mockApiRequest.mockResolvedValue(progress(8))
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('8 з 10')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('після невдалого читання не видає останнє відоме число за поточне', async () => {
    const client = createTestQueryClient()

    mockApiRequest.mockResolvedValueOnce(progress(5))
    render(withQueryClient(<ActivationChecklist />, client))
    expect(await screen.findByText('5 з 10')).toBeInTheDocument()

    mockApiRequest.mockRejectedValue(new Error('мережа впала'))
    await client.invalidateQueries({ queryKey: ['activation'] })

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('5 з 10')).not.toBeInTheDocument()
  })
})

describe('пороги й CTA', () => {
  it('нуль книжок: кличе додати першу', () => {
    renderChecklist({ status: 'ready', data: progress(0) })

    expect(screen.getByText('0 з 10')).toBeInTheDocument()
    expect(screen.getByText(/Перша книжка — найважливіша/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Додати книжку' })).toHaveAttribute(
      'href',
      '/catalog/new',
    )
    expect(bar()).toHaveValue(0)
  })

  it('одна книжка: лишилося девʼять, і це все ще ADD_BOOKS', () => {
    renderChecklist({ status: 'ready', data: progress(1) })

    expect(screen.getByText('1 з 10')).toBeInTheDocument()
    expect(screen.getByText(/Ще 9 до 10/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Додати книжку' })).toBeInTheDocument()
    expect(bar()).toHaveValue(10)
  })

  it('девʼята книжка ще не відкриває друзів', () => {
    renderChecklist({ status: 'ready', data: progress(9) })

    expect(screen.getByText(/Ще 1 до 10/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Додати книжку' })).toHaveAttribute(
      'href',
      '/catalog/new',
    )
    expect(bar()).toHaveValue(90)
  })

  it('десята книжка веде до друзів', () => {
    renderChecklist({ status: 'ready', data: progress(10) })

    expect(screen.getByText('10 з 10')).toBeInTheDocument()
    expect(screen.getByText(/Час запросити друзів/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Запросити друзів' })).toHaveAttribute(
      'href',
      '/friends',
    )
    expect(bar()).toHaveValue(100)
  })

  it.each([11, 40, 250])('%i книжок — прогрес не перелітає за 100%%', (ownedCopyCount) => {
    renderChecklist({ status: 'ready', data: progress(ownedCopyCount) })

    expect(bar()).toHaveValue(100)
    expect(screen.getByLabelText('Заповнено на 100%')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Запросити друзів' })).toBeInTheDocument()
  })
})

describe('помилка не відкриває двері автоматичним запитам', () => {
  /**
   * `retry: false` stops TanStack Query from repeating one failed attempt. It
   * does not stop focus, reconnect or a new observer from starting a fresh one
   * — and after a failure those are exactly the triggers that would ask again
   * without anybody pressing the button.
   */
  afterEach(() => {
    // Both managers are module-level globals: left as-is they would leak a
    // blurred window or an offline flag into every suite that runs after this.
    focusManager.setFocused(undefined)
    onlineManager.setOnline(true)
  })

  /** Keeps the cache across an unmount, unlike the shared `gcTime: 0` helper. */
  function createRetainingClient(): QueryClient {
    return new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false, gcTime: 60_000 } },
    })
  }

  /** Server failed, the person retried, and the retry failed too. */
  async function afterFailedManualRetry(): Promise<void> {
    mockApiRequest.mockRejectedValue(new Error('мережа впала'))

    renderChecklist({ status: 'error' })

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByText(/Не вдалося оновити прогрес/)).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
  }

  it('повернення фокуса у вікно не додає запиту', async () => {
    await afterFailedManualRetry()

    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('відновлення мережі не додає запиту', async () => {
    await afterFailedManualRetry()

    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockApiRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('повторне монтування над помилковим запитом не стартує GET', async () => {
    const client = createRetainingClient()

    // Без серверного знімка — той самий шлях, яким чеклист живе в
    // AddBookSuccess і на COMMITTED-екрані імпорту.
    mockApiRequest.mockRejectedValue(new Error('мережа впала'))

    const first = render(withQueryClient(<ActivationChecklist />, client))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(1)

    first.unmount()
    render(withQueryClient(<ActivationChecklist />, client))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
  })

  it('кнопка працює й після невдалого повтору — рівно один новий запит', async () => {
    await afterFailedManualRetry()

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    // `waitFor`, not a bare assertion: the refetch is started by the click but
    // the request itself is asynchronous, and on a loaded machine it need not
    // have been issued by the time the click's act() flush returns.
    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledTimes(2)
    })

    // І третє натискання так само доходить до сервера, вже успішно.
    mockApiRequest.mockResolvedValue(progress(7))
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('7 з 10')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledTimes(3)
  })

  it('після успішного повтору інвалідація знову оновлює активний запит', async () => {
    mockApiRequest.mockRejectedValueOnce(new Error('мережа впала'))

    const client = createTestQueryClient()

    render(withQueryClient(<ActivationChecklist initial={{ status: 'error' }} />, client))

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    mockApiRequest.mockResolvedValue(progress(4))
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByText('4 з 10')).toBeInTheDocument()

    // Freshness повернулася до звичайної: те, що робить add/import/delete.
    mockApiRequest.mockResolvedValue(progress(5))
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['activation'] })
    })

    expect(await screen.findByText('5 з 10')).toBeInTheDocument()
  })
})
