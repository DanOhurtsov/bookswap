/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
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

const friend = { id: 'f-1', displayName: 'Олена', handle: 'olena', avatarUrl: null }

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
      textKind: 'ORIGINAL',
      language: 'en',
      translator: null,
      owners: [{ owner: friend, relation: 'FRIEND', availableCopies: 1, copies: [copyOf('c-1')] }],
    },
    {
      translationId: 't-1',
      textKind: 'TRANSLATION',
      language: 'uk',
      translator: 'Ірина',
      owners: [
        {
          owner: { id: 'f-2', displayName: 'Тарас', handle: 'f-2', avatarUrl: null },
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
    render(<HoldersPanel workId="w-1" workTitle="Дюна" />)

    expect(await screen.findByRole('heading', { name: 'Оригінал (en)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'uk · Ірина' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Олена' })).toHaveAttribute('href', '/u/olena')
    expect(screen.getByText(/орієнтовно вільна 1 листопада 2026/)).toBeInTheDocument()
    expect(apiRequestWithRedirect).toHaveBeenCalledWith(
      '/works/w-1/holders',
      expect.objectContaining({ schema: expect.anything() }),
    )
  })

  it('невідомий текст — окрема група, а не «оригінал»; мова може бути невідомою', async () => {
    apiRequestWithRedirect.mockResolvedValue({
      data: {
        workId: 'w-1',
        groups: [
          { ...response.groups[0], translationId: null },
          {
            translationId: null,
            textKind: 'UNKNOWN',
            language: null,
            translator: null,
            owners: response.groups[0]?.owners ?? [],
          },
        ],
      },
      redirected: false,
    })
    render(<HoldersPanel workId="w-1" workTitle="Дюна" />)

    expect(await screen.findByRole('heading', { name: 'Оригінал (en)' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Оригінал чи переклад — невідомо' }),
    ).toBeInTheDocument()
  })

  it('empty state points to inviting friends', async () => {
    apiRequestWithRedirect.mockResolvedValue({
      data: { workId: 'w-1', groups: [] },
      redirected: false,
    })
    render(<HoldersPanel workId="w-1" workTitle="Дюна" />)

    expect(await screen.findByText(/У ваших друзів цієї книжки немає/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Запросити друзів' })).toHaveAttribute(
      'href',
      '/friends',
    )
  })

  it('shows an error with retry', async () => {
    apiRequestWithRedirect.mockRejectedValueOnce(new Error('x'))
    render(<HoldersPanel workId="w-1" workTitle="Дюна" />)

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))
    expect(await screen.findByRole('heading', { name: 'Оригінал (en)' })).toBeInTheDocument()
  })

  it('requests a copy in place and refetches so canRequest can flip; the outcome outlives the refetch', async () => {
    apiRequest.mockResolvedValue({ loan: { id: 'loan-new' } })
    render(<HoldersPanel workId="w-1" workTitle="Дюна" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Попросити' }))

    // jsdom has no `matchMedia`: the narrow layout, the phone's sheet over the panel, naming the work.
    const sheet = screen.getByRole('dialog', { name: 'Попросити книжку' })

    expect(sheet).toHaveAccessibleDescription('Дюна')
    expect(document.querySelector('form')).toBeNull()

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
    await userEvent.click(within(sheet).getByRole('button', { name: 'Надіслати запит' }))

    await screen.findByRole('heading', { name: 'Запит надіслано' })
    expect(apiRequest).toHaveBeenCalledWith(
      '/loans',
      expect.objectContaining({ method: 'POST', body: { copyId: 'c-1' } }),
    )
    await waitFor(() => {
      expect(apiRequestWithRedirect).toHaveBeenCalledTimes(2)
    })
    expect(screen.getByRole('heading', { name: 'Запит надіслано' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Відкрити запит' })).toHaveAttribute(
      'href',
      '/loans?loanId=loan-new&role=borrower',
    )

    await userEvent.click(
      within(screen.getByRole('status')).getByRole('button', { name: 'Закрити' }),
    )

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
    expect(screen.queryByRole('button', { name: 'Попросити' })).not.toBeInTheDocument()
    expect(screen.getByText('Зараз попросити не можна.')).toBeInTheDocument()
    expect(screen.getByText('Вдома, вільна')).toHaveFocus()
  })
})
