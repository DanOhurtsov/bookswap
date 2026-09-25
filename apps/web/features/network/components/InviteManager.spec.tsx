/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { InviteManager } from './InviteManager'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const invitation = {
  id: 'i-1',
  kind: 'LINK',
  status: 'ACTIVE',
  expiresAt: '2026-10-09T12:00:00.000Z',
  createdAt: '2026-09-25T12:00:00.000Z',
  acceptedCount: 2,
  maxUses: 10,
}

let list = [invitation]

beforeEach(() => {
  jest.clearAllMocks()
  list = [invitation]
  apiRequest.mockImplementation((path: string, options?: { method?: string; body?: unknown }) => {
    if (path === '/invitations' && options?.method === 'POST') {
      return Promise.resolve(
        (options.body as { kind: string }).kind === 'LINK'
          ? { invitation, token: 'secret-token' }
          : { invitation: { ...invitation, kind: 'EMAIL' } },
      )
    }

    if (path === '/invitations') return Promise.resolve({ invitations: list })

    return Promise.resolve(undefined)
  })
})

describe('InviteManager', () => {
  it('lists my invitations with status and use count', async () => {
    render(<InviteManager />)

    expect(await screen.findByText(/Посилання · чинне · прийнято 2\/10/)).toBeInTheDocument()
  })

  it('creating a link shows it once, with the note; a remount never shows it again', async () => {
    const { unmount } = render(<InviteManager />)

    await userEvent.click(await screen.findByRole('button', { name: 'Створити посилання' }))

    const field = await screen.findByLabelText('Посилання-запрошення')

    expect((field as HTMLInputElement).value).toMatch(/\/invite#secret-token$/)
    expect(
      screen.getByText(/показується один раз; дійсне 14 днів, до 10 людей/),
    ).toBeInTheDocument()

    unmount()
    render(<InviteManager />)
    await screen.findByText(/чинне/)

    expect(screen.queryByLabelText('Посилання-запрошення')).not.toBeInTheDocument()
  })

  it('email success message does not depend on the address', async () => {
    render(<InviteManager />)
    const messages: string[] = []

    for (const address of ['known@example.com', 'unknown@example.com']) {
      await userEvent.type(screen.getByLabelText('Запросити поштою'), address)
      await userEvent.click(screen.getByRole('button', { name: 'Надіслати лист' }))
      messages.push((await screen.findByRole('status')).textContent)
    }

    expect(messages[0]).toBe(messages[1])
    expect(apiRequest).toHaveBeenCalledWith(
      '/invitations',
      expect.objectContaining({ body: { kind: 'EMAIL', email: 'known@example.com' } }),
    )
  })

  it('revoke calls DELETE and refreshes the list', async () => {
    render(<InviteManager />)
    await userEvent.click(await screen.findByRole('button', { name: 'Відкликати' }))

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith('/invitations/i-1', { method: 'DELETE' }),
    )
  })

  it('hides «Відкликати» for a non-active invitation', async () => {
    list = [{ ...invitation, status: 'REVOKED' }]
    render(<InviteManager />)

    expect(await screen.findByText(/відкликано/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Відкликати' })).not.toBeInTheDocument()
  })

  it.each([
    ['INVITE_RATE_LIMITED', 429, /Забагато запрошень/],
    ['INVITE_EMAIL_UNVERIFIED', 403, /підтвердьте власну адресу/],
    ['INVITE_EMAIL_FAILED', 502, /Не вдалося надіслати лист/],
  ])('maps %s to friendly text', async (code, status, text) => {
    apiRequest.mockImplementation((...args: [string, { method?: string }?]) =>
      args[1]?.method === 'POST'
        ? Promise.reject(new ApiRequestError(status, { code, message: 'raw' } as never))
        : Promise.resolve({ invitations: [] }),
    )
    render(<InviteManager />)
    await userEvent.type(await screen.findByLabelText('Запросити поштою'), 'a@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати лист' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })
})
