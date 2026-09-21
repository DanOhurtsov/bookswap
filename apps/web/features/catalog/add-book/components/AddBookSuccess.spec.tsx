/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { withQueryClient } from '@/app/lib/test-query-client'
import { AddBookSuccess } from './AddBookSuccess'

/**
 * The success step carries the activation checklist (Stage 8h-2), so it needs
 * both a session and a query client the same way the library page does.
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'user-1' } },
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

function renderSuccess(handlers: {
  onRepeatEdition?: jest.Mock
  onAddNext?: jest.Mock
  onScanNext?: jest.Mock
}): void {
  render(
    withQueryClient(
      <AddBookSuccess
        title="Кобзар"
        workId="work-1"
        onRepeatEdition={handlers.onRepeatEdition ?? jest.fn()}
        onAddNext={handlers.onAddNext ?? jest.fn()}
        onScanNext={handlers.onScanNext ?? jest.fn()}
      />,
    ),
  )
}

beforeEach(() => {
  mockApiRequest.mockReset()
  mockApiRequest.mockReturnValue(new Promise(() => undefined))
})

it('offers all three post-success actions', async () => {
  const user = userEvent.setup()
  const onRepeatEdition = jest.fn()
  const onAddNext = jest.fn()
  const onScanNext = jest.fn()

  renderSuccess({ onRepeatEdition, onAddNext, onScanNext })

  await user.click(screen.getByRole('button', { name: 'Ще один такий примірник' }))
  await user.click(screen.getByRole('button', { name: 'Додати наступну книгу' }))
  await user.click(screen.getByRole('button', { name: 'Сканувати наступну' }))

  expect(onRepeatEdition).toHaveBeenCalledTimes(1)
  expect(onAddNext).toHaveBeenCalledTimes(1)
  expect(onScanNext).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('link', { name: 'До бібліотеки' })).toHaveAttribute('href', '/library')
  expect(screen.getByRole('link', { name: 'Сторінка твору' })).toHaveAttribute(
    'href',
    '/works/work-1',
  )
})

it('показує прогрес до перших 10 книжок одразу після додавання', async () => {
  mockApiRequest.mockResolvedValue({
    ownedCopyCount: 4,
    target: 10,
    hasReachedTarget: false,
    nextAction: 'ADD_BOOKS',
  })

  renderSuccess({})

  // Читається з того самого `['activation']`, який щойно інвалідував `CopyStep`.
  expect(await screen.findByText('4 з 10')).toBeInTheDocument()
  expect(mockApiRequest).toHaveBeenCalledWith('/me/activation', expect.anything())
})

it('на десятій книжці веде до друзів', async () => {
  mockApiRequest.mockResolvedValue({
    ownedCopyCount: 10,
    target: 10,
    hasReachedTarget: true,
    nextAction: 'INVITE_FRIENDS',
  })

  renderSuccess({})

  expect(await screen.findByRole('link', { name: 'Запросити друзів' })).toHaveAttribute(
    'href',
    '/friends',
  )
})
