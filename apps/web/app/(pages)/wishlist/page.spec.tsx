/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Work, WorkAuthor } from '@bookswap/shared'
import { NAVBAR_PROFILE_LINKS } from '@/constants/navigation'
import WishlistPage from './page'

/**
 * Конкурентний прохід над §6.5/§8 (Етап 7f): доводить реальне wiring на
 * сторінці вішлиста з ДВОМА різними рядками — не лише чисту функцію чи
 * ізольований хук, а справжній клік по двох кнопках, справжній `useWishlist`,
 * справжній рендер.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'me', name: 'Тест', email: 't@example.com' } },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void

  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function work(id: string, title: string): Work {
  return {
    id,
    title,
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
  }
}

const authors: WorkAuthor[] = [
  { id: 'author-1', name: 'Автор', nameLatin: null, role: 'AUTHOR', position: 0 },
]

const workA = work('work-a', 'Твір А')
const workB = work('work-b', 'Твір Б')

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('паралельне «Прибрати» на двох різних рядках: успіх одного не воскрешає провал іншого', async () => {
  const user = userEvent.setup()
  const items = [
    { id: 'item-a', workId: workA.id, work: workA, authors, createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'item-b', workId: workB.id, work: workB, authors, createdAt: '2024-01-01T00:00:00.000Z' },
  ]
  const deferredByWorkId = new Map<string, Deferred<void>>()

  mockApiRequest.mockImplementation(
    async (path: string, options: { method?: string } = {}): Promise<unknown> => {
      const method = options.method ?? 'GET'

      if (path === '/me/wishlist' && method === 'GET') return { items: [...items] }

      const match = /^\/me\/wishlist\/(.+)$/.exec(path)

      if (match && method === 'DELETE') {
        const workId = decodeURIComponent(match[1] ?? '')
        const deferred = createDeferred<void>()

        deferredByWorkId.set(workId, deferred)
        await deferred.promise

        return undefined
      }

      throw new Error(`Немає фейкової відповіді для ${path} ${method}`)
    },
  )

  render(<WishlistPage />)

  await screen.findByText('Твір А')
  await screen.findByText('Твір Б')

  const rowA = screen.getByText('Твір А').closest('li')
  const rowB = screen.getByText('Твір Б').closest('li')

  if (rowA === null || rowB === null) throw new Error('рядки вішлиста не знайдено')

  await user.click(within(rowA).getByRole('button', { name: 'Прибрати' }))
  await user.click(within(rowB).getByRole('button', { name: 'Прибрати' }))

  // Обидва рядки оптимістично зникають одразу, до відповіді сервера.
  await waitFor(() => {
    expect(screen.queryByText('Твір А')).not.toBeInTheDocument()
    expect(screen.queryByText('Твір Б')).not.toBeInTheDocument()
  })

  // B успішний.
  items.splice(
    items.findIndex((item) => item.workId === workB.id),
    1,
  )
  deferredByWorkId.get(workB.id)?.resolve()

  // A провалюється.
  deferredByWorkId.get(workA.id)?.reject(new Error('boom'))

  // A повертається (відкат ЛИШЕ своєї операції), B успішно видалений не воскресає.
  await screen.findByText('Твір А')
  expect(screen.queryByText('Твір Б')).not.toBeInTheDocument()
})

it('BS-104: сторінка доступна з меню профілю, а не лише з нижнього блоку сторінки твору', () => {
  expect(NAVBAR_PROFILE_LINKS).toContainEqual({ href: '/wishlist', label: 'Вішлист' })
})
