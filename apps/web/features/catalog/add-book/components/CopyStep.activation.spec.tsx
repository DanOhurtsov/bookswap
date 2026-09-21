/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { QueryClient } from '@tanstack/react-query'
import { ApiRequestError } from '@/app/lib/api'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { ACTIVATION_QUERY_KEY } from '@/features/library/activation/index.client'
import { CopyStep } from './CopyStep'

/**
 * Stage 8h-2: adding a copy is what moves the activation checklist.
 *
 * This form is the only place the wizard creates one — the first book and every
 * «ще один такий примірник» both submit it — so both cases are the same code
 * path exercised twice, and a refused request must move nothing at all.
 *
 * It lives inside the add-book feature rather than beside the checklist because
 * `CopyStep` is internal to this feature: testing it from outside would mean
 * widening the feature's public barrel for a test (CONVENTIONS.md §1.3).
 */
jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

/** Calls that targeted the activation key specifically, ignoring every other key. */
function activationInvalidations(invalidate: jest.SpyInstance): unknown[] {
  return invalidate.mock.calls.filter(
    ([options]) =>
      JSON.stringify((options as { queryKey?: unknown }).queryKey) ===
      JSON.stringify(ACTIVATION_QUERY_KEY),
  )
}

function harness(): { client: QueryClient; invalidate: jest.SpyInstance } {
  const client = createTestQueryClient()

  return { client, invalidate: jest.spyOn(client, 'invalidateQueries') }
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

describe('додавання примірника (звичайний шлях і repeat add)', () => {
  async function addCopy(client: QueryClient, onDone = jest.fn()): Promise<void> {
    const view = render(withQueryClient(<CopyStep editionId="edition-1" onDone={onDone} />, client))

    await userEvent.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    // Repeat-add remounts this step for the same edition; unmounting between
    // passes is what makes the second render that remount rather than a second
    // form sitting beside the first.
    view.unmount()
  }

  it('успішний POST /me/library інвалідує саме ["activation"]', async () => {
    const { client, invalidate } = harness()
    mockApiRequest.mockResolvedValue({ copy: { id: 'copy-1' } })

    await addCopy(client)

    expect(activationInvalidations(invalidate)).toHaveLength(1)
  })

  it('repeat add — той самий крок удруге — інвалідує ще раз', async () => {
    const { client, invalidate } = harness()
    mockApiRequest.mockResolvedValue({ copy: { id: 'copy-1' } })

    // «Ще один такий примірник» повертає майстер на той самий CopyStep із тим
    // самим editionId, тож це буквально другий прохід тією самою формою.
    await addCopy(client)
    await addCopy(client)

    expect(activationInvalidations(invalidate)).toHaveLength(2)
  })

  it('відхилений POST не інвалідує нічого', async () => {
    const { client, invalidate } = harness()
    mockApiRequest.mockRejectedValue(
      new ApiRequestError(404, { code: 'NOT_FOUND', message: 'Видання не знайдено' }),
    )

    const view = render(
      withQueryClient(<CopyStep editionId="edition-1" onDone={jest.fn()} />, client),
    )

    await userEvent.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/Видання не знайдено/)).toBeInTheDocument()
    expect(activationInvalidations(invalidate)).toHaveLength(0)
    view.unmount()
  })
})
