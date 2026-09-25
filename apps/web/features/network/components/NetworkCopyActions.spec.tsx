/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { NetworkCopy } from '@bookswap/shared'
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

const renderCopy = (
  over: Partial<NetworkCopy>,
  relation: 'FRIEND' | 'OTHER' | 'SELF' = 'FRIEND',
  onRequested = jest.fn(),
) =>
  render(
    <ul>
      <NetworkCopyActions
        copy={{ ...copy, ...over }}
        relation={relation}
        onRequested={onRequested}
      />
    </ul>,
  )

beforeEach(() => {
  jest.clearAllMocks()
  apiRequest.mockResolvedValue(undefined)
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

  it('requests in place, then refreshes the caller, and waits for the refresh', async () => {
    const onRequested = jest.fn().mockResolvedValue(undefined)

    renderCopy({}, 'FRIEND', onRequested)
    await userEvent.click(screen.getByRole('button', { name: 'Попросити' }))
    await userEvent.type(screen.getByLabelText('Повідомлення'), 'Дякую!')
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

    await waitFor(() => expect(onRequested).toHaveBeenCalledTimes(1))
    expect(apiRequest).toHaveBeenCalledWith('/loans', {
      method: 'POST',
      body: { copyId: 'c-1', message: 'Дякую!' },
    })
  })

  it('a failed request shows the error and keeps the form for another try', async () => {
    apiRequest.mockRejectedValue(new Error('Мережа'))
    renderCopy({})
    await userEvent.click(screen.getByRole('button', { name: 'Попросити' }))
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Надіслати запит' })).toBeEnabled()
  })
})
