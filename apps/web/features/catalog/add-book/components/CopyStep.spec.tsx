/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { CopyResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { CopyStep } from './CopyStep'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const createdCopy: CopyResponse = {
  copy: {
    id: 'copy-new',
    status: 'AVAILABLE',
    visibility: 'FRIENDS',
    condition: 'GOOD',
    note: null,
    acquiredAt: null,
    createdAt: '2026-09-03T00:00:00.000Z',
    isHome: true,
    holder: null,
    activeLoan: null,
    pendingRequestCount: 0,
  },
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('submits GOOD and FRIENDS defaults with empty note and date as null', async () => {
  mockApiRequest.mockResolvedValue(createdCopy)
  const onDone = jest.fn()
  render(withQueryClient(<CopyStep editionId="edition-1" onDone={onDone} />))
  const user = userEvent.setup()

  expect(screen.getByLabelText('Стан примірника')).toHaveValue('GOOD')
  expect(screen.getByLabelText('Кому показувати')).toHaveValue('FRIENDS')
  await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library',
      expect.objectContaining({
        method: 'POST',
        body: {
          editionId: 'edition-1',
          condition: 'GOOD',
          visibility: 'FRIENDS',
          note: null,
          acquiredAt: null,
          entryMethod: 'MANUAL',
        },
      }),
    )
  })
  expect(onDone).toHaveBeenCalledTimes(1)
})

it('submits an exact calendar date and trimmed private note', async () => {
  mockApiRequest.mockResolvedValue(createdCopy)
  render(withQueryClient(<CopyStep editionId="edition-1" onDone={jest.fn()} />))
  const user = userEvent.setup()

  await user.selectOptions(screen.getByLabelText('Стан примірника'), 'DAMAGED')
  await user.selectOptions(screen.getByLabelText('Кому показувати'), 'PRIVATE')
  await user.type(screen.getByLabelText('Нотатка'), '  Підписаний примірник  ')
  await user.type(screen.getByLabelText('Коли зʼявилася'), '2026-09-01')
  await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library',
      expect.objectContaining({
        body: {
          editionId: 'edition-1',
          condition: 'DAMAGED',
          visibility: 'PRIVATE',
          note: 'Підписаний примірник',
          acquiredAt: '2026-09-01',
          entryMethod: 'MANUAL',
        },
      }),
    )
  })
})

it('keeps entered copy metadata and exposes an API error', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(409, { code: 'CONFLICT', message: 'Примірник не вдалося додати' }),
  )
  const onDone = jest.fn()
  render(withQueryClient(<CopyStep editionId="edition-1" onDone={onDone} />))
  const user = userEvent.setup()

  await user.type(screen.getByLabelText('Нотатка'), 'Особиста нотатка')
  await user.type(screen.getByLabelText('Коли зʼявилася'), '2026-08-15')
  await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

  expect(await screen.findByText('Примірник не вдалося додати')).toBeInTheDocument()
  expect(screen.getByLabelText('Нотатка')).toHaveValue('Особиста нотатка')
  expect(screen.getByLabelText('Коли зʼявилася')).toHaveValue('2026-08-15')
  expect(onDone).not.toHaveBeenCalled()
})

it('keeps only condition and visibility defaults for the next copy', () => {
  render(
    withQueryClient(
      <CopyStep
        editionId="edition-2"
        defaults={{ condition: 'WORN', visibility: 'PRIVATE' }}
        onDone={jest.fn()}
      />,
    ),
  )

  expect(screen.getByLabelText('Стан примірника')).toHaveValue('WORN')
  expect(screen.getByLabelText('Кому показувати')).toHaveValue('PRIVATE')
  expect(screen.getByLabelText('Нотатка')).toHaveValue('')
  expect(screen.getByLabelText('Коли зʼявилася')).toHaveValue('')
})

it('allows only one in-flight request when the form is submitted twice', async () => {
  let resolveRequest: ((copy: CopyResponse) => void) | undefined
  mockApiRequest.mockImplementation(
    () =>
      new Promise<CopyResponse>((resolve) => {
        resolveRequest = resolve
      }),
  )
  const onDone = jest.fn()
  render(withQueryClient(<CopyStep editionId="edition-1" onDone={onDone} />))

  const submitButton = screen.getByRole('button', { name: 'Додати до бібліотеки' })
  const form = submitButton.closest('form')
  if (form === null) throw new Error('Copy form not found')

  fireEvent.submit(form)
  fireEvent.submit(form)

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledTimes(1)
  })

  resolveRequest?.(createdCopy)

  await waitFor(() => {
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
