/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { ApiRequestError } from '@/app/lib/api'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReadingListItem, ReadingListResponse, ReadingListStatus } from '@bookswap/shared'
import { ReadingListScreen } from './ReadingListScreen'

/** RS14 (10j.2): the private reading list — filters, cursor pages, tag and every state. */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function apiError(message: string): ApiRequestError {
  return new ApiRequestError(503, { code: 'INTERNAL_ERROR', message })
}

function item(id: string, status: ReadingListStatus, wasBorrowed = false): ReadingListItem {
  return {
    work: {
      id,
      title: `Твір ${id}`,
      origLang: 'uk',
      firstPubYear: null,
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
    },
    authors: [{ id: `a-${id}`, name: `Автор ${id}`, nameLatin: null, role: 'AUTHOR', position: 0 }],
    status,
    wasBorrowed,
    updatedAt: '2026-09-30T10:00:00.000Z',
  }
}

function page(items: ReadingListItem[], nextCursor: string | null = null): ReadingListResponse {
  return { items, nextCursor }
}

function paths(): string[] {
  return apiRequest.mock.calls.map(([path]) => path as string)
}

function filterButton(name: string): HTMLElement {
  return within(screen.getByRole('navigation', { name: 'Фільтр списку читання' })).getByRole(
    'button',
    { name },
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockReset()
})

describe('ReadingListScreen (RS14)', () => {
  it('loads all listed works with status chips, the tag only where borrowed, and work links', async () => {
    apiRequest.mockResolvedValueOnce(page([item('w-1', 'READ', true), item('w-2', 'READING')]))

    render(<ReadingListScreen />)

    expect(screen.getByText('Завантажую…')).toBeInTheDocument()

    const first = (await screen.findByRole('link', { name: 'Твір w-1' })).closest('li')
    const second = screen.getByRole('link', { name: 'Твір w-2' }).closest('li')

    expect(screen.getByRole('link', { name: 'Твір w-1' })).toHaveAttribute('href', '/works/w-1')
    expect(within(first as HTMLElement).getByText('Прочитано')).toBeInTheDocument()
    expect(within(first as HTMLElement).getByText('Була позичена')).toBeInTheDocument()
    expect(within(second as HTMLElement).getByText('Читаю')).toBeInTheDocument()
    expect(within(second as HTMLElement).queryByText('Була позичена')).not.toBeInTheDocument()
    expect(paths()).toEqual(['/me/reading-list'])
    expect(filterButton('Усі')).toHaveAttribute('aria-pressed', 'true')
  })

  it('offers only «Усі» / «Читаю» / «Прочитано» — there is no «Не читав» list', async () => {
    apiRequest.mockResolvedValue(page([]))

    render(<ReadingListScreen />)
    await screen.findByText(/Тут поки порожньо/)

    const filters = within(screen.getByRole('navigation', { name: 'Фільтр списку читання' }))

    expect(filters.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Усі',
      'Читаю',
      'Прочитано',
    ])
    expect(screen.queryByText('Не читав')).not.toBeInTheDocument()
  })

  it('filters by status through the query string and shows a per-filter empty state', async () => {
    const user = userEvent.setup()

    apiRequest.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/me/reading-list?status=READING'
          ? page([item('w-2', 'READING')])
          : path === '/me/reading-list?status=READ'
            ? page([])
            : page([item('w-1', 'READ'), item('w-2', 'READING')]),
      ),
    )

    render(<ReadingListScreen />)
    await screen.findByRole('link', { name: 'Твір w-1' })

    await user.click(filterButton('Читаю'))

    expect(await screen.findByRole('link', { name: 'Твір w-2' })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Твір w-1' })).not.toBeInTheDocument()
    })
    expect(filterButton('Читаю')).toHaveAttribute('aria-pressed', 'true')

    await user.click(filterButton('Прочитано'))

    expect(await screen.findByText('Прочитаних творів поки немає.')).toBeInTheDocument()

    await user.click(filterButton('Усі'))

    expect(await screen.findByRole('link', { name: 'Твір w-1' })).toBeInTheDocument()
    expect(paths()).toEqual([
      '/me/reading-list',
      '/me/reading-list?status=READING',
      '/me/reading-list?status=READ',
      '/me/reading-list',
    ])
  })

  it('appends the next cursor page and hides «Показати ще» on the last one', async () => {
    const user = userEvent.setup()

    apiRequest
      .mockResolvedValueOnce(page([item('w-1', 'READ')], 'cursor-1'))
      .mockResolvedValueOnce(page([item('w-2', 'READ')], 'cursor-2'))
      .mockResolvedValueOnce(page([item('w-3', 'READING')]))

    render(<ReadingListScreen />)
    await user.click(await screen.findByRole('button', { name: 'Показати ще' }))
    expect(await screen.findByRole('link', { name: 'Твір w-2' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Показати ще' }))
    expect(await screen.findByRole('link', { name: 'Твір w-3' })).toBeInTheDocument()

    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.queryByRole('button', { name: 'Показати ще' })).not.toBeInTheDocument()
    expect(paths()).toEqual([
      '/me/reading-list',
      '/me/reading-list?cursor=cursor-1',
      '/me/reading-list?cursor=cursor-2',
    ])
  })

  it('keeps the filter on the next page request', async () => {
    const user = userEvent.setup()

    apiRequest
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([item('w-1', 'READ')], 'cursor-r'))
      .mockResolvedValueOnce(page([item('w-2', 'READ')]))

    render(<ReadingListScreen />)
    await screen.findByText(/Тут поки порожньо/)
    await user.click(filterButton('Прочитано'))
    await user.click(await screen.findByRole('button', { name: 'Показати ще' }))

    expect(await screen.findByRole('link', { name: 'Твір w-2' })).toBeInTheDocument()
    expect(paths()[2]).toBe('/me/reading-list?status=READ&cursor=cursor-r')
  })

  it('a failed next page keeps the loaded items and retries the same cursor', async () => {
    const user = userEvent.setup()

    apiRequest
      .mockResolvedValueOnce(page([item('w-1', 'READ')], 'cursor-1'))
      .mockRejectedValueOnce(apiError('Немає звʼязку'))
      .mockResolvedValueOnce(page([item('w-2', 'READ')]))

    render(<ReadingListScreen />)
    await user.click(await screen.findByRole('button', { name: 'Показати ще' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Немає звʼязку')
    expect(screen.getByRole('link', { name: 'Твір w-1' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('link', { name: 'Твір w-2' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(paths()).toEqual([
      '/me/reading-list',
      '/me/reading-list?cursor=cursor-1',
      '/me/reading-list?cursor=cursor-1',
    ])
  })

  it('a page of the previous filter that lands late is not appended to the new filter', async () => {
    const user = userEvent.setup()
    let lateSettle: (value: ReadingListResponse) => void = () => undefined

    apiRequest
      .mockResolvedValueOnce(page([item('w-1', 'READ')], 'cursor-1'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            lateSettle = resolve
          }),
      )
      .mockResolvedValueOnce(page([item('w-9', 'READING')]))

    render(<ReadingListScreen />)
    await user.click(await screen.findByRole('button', { name: 'Показати ще' }))
    await user.click(filterButton('Читаю'))
    expect(await screen.findByRole('link', { name: 'Твір w-9' })).toBeInTheDocument()

    lateSettle(page([item('w-late', 'READ')]))

    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
    })
    expect(screen.queryByRole('link', { name: 'Твір w-late' })).not.toBeInTheDocument()
  })

  it('a failed first load shows an error and a retry that loads the list', async () => {
    const user = userEvent.setup()

    apiRequest
      .mockRejectedValueOnce(apiError('Сервер недоступний'))
      .mockResolvedValueOnce(page([item('w-1', 'READING')]))

    render(<ReadingListScreen />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Сервер недоступний')

    await user.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByRole('link', { name: 'Твір w-1' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
