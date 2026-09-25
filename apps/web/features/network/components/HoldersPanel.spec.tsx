/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkCopy, WorkHoldersResponse } from '@bookswap/shared'
import { HoldersPanel } from './HoldersPanel'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn(), apiRequestWithRedirect: jest.fn() }
})

const { apiRequest, apiRequestWithRedirect } = jest.requireMock<{
  apiRequest: jest.Mock
  apiRequestWithRedirect: jest.Mock
}>('@/app/lib/api')

const friend = { id: 'f-1', displayName: 'Олена', avatarUrl: null }

function copyOf(id: string, over: Partial<NetworkCopy> = {}): NetworkCopy {
  return {
    id,
    editionId: 'e-1',
    translationId: null,
    status: 'AVAILABLE',
    expectedReturnAt: null,
    canRequest: true,
    ...over,
  }
}

const response: WorkHoldersResponse = {
  workId: 'w-1',
  groups: [
    {
      translationId: null,
      language: 'en',
      translator: null,
      owners: [{ owner: friend, relation: 'FRIEND', availableCopies: 1, copies: [copyOf('c-1')] }],
    },
    {
      translationId: 't-1',
      language: 'uk',
      translator: 'Ірина',
      owners: [
        {
          owner: { id: 'f-2', displayName: 'Тарас', avatarUrl: null },
          relation: 'FRIEND',
          availableCopies: 0,
          copies: [
            copyOf('c-2', {
              status: 'LENT_OUT',
              canRequest: false,
              expectedReturnAt: '2026-11-01',
            }),
          ],
        },
      ],
    },
  ],
}

beforeEach(() => {
  jest.clearAllMocks()
  apiRequestWithRedirect.mockResolvedValue({ data: response, redirected: false })
  apiRequest.mockResolvedValue(undefined)
})

describe('HoldersPanel', () => {
  it('groups owners by translation with the expected return date', async () => {
    render(<HoldersPanel workId="w-1" />)

    expect(await screen.findByRole('heading', { name: 'Оригінал (en)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'uk · Ірина' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Олена' })).toHaveAttribute(
      'href',
      '/users/f-1/library',
    )
    expect(screen.getByText(/орієнтовно вільна 1 листопада 2026/)).toBeInTheDocument()
    expect(apiRequestWithRedirect).toHaveBeenCalledWith(
      '/works/w-1/holders',
      expect.objectContaining({ schema: expect.anything() }),
    )
  })

  it('empty state points to inviting friends', async () => {
    apiRequestWithRedirect.mockResolvedValue({
      data: { workId: 'w-1', groups: [] },
      redirected: false,
    })
    render(<HoldersPanel workId="w-1" />)

    expect(await screen.findByText(/У ваших друзів цієї книжки немає/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Запросити друзів' })).toHaveAttribute(
      'href',
      '/friends',
    )
  })

  it('shows an error with retry', async () => {
    apiRequestWithRedirect.mockRejectedValueOnce(new Error('x'))
    render(<HoldersPanel workId="w-1" />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByRole('heading', { name: 'Оригінал (en)' })).toBeInTheDocument()
  })

  it('requests a copy in place and refetches so canRequest can flip', async () => {
    render(<HoldersPanel workId="w-1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Попросити' }))
    apiRequestWithRedirect.mockResolvedValue({
      data: {
        ...response,
        groups: [
          {
            ...response.groups[0],
            owners: [
              { ...response.groups[0]?.owners[0], copies: [copyOf('c-1', { canRequest: false })] },
            ],
          },
        ],
      },
      redirected: false,
    })
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith('/loans', {
        method: 'POST',
        body: { copyId: 'c-1' },
      }),
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Попросити' })).not.toBeInTheDocument(),
    )
    expect(apiRequestWithRedirect).toHaveBeenCalledTimes(2)
  })
})
