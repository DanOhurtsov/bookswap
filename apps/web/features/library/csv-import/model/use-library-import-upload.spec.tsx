/** @jest-environment jsdom */

import { act, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import type { ReactNode } from 'react'
import { ApiRequestError } from '@/app/lib/api'
import { Providers } from '@/app/lib/query-client'
import { buildDraft, buildRow } from '../library-import.test-helpers'
import { useLibraryImportUpload } from './use-library-import-upload'

/**
 * Session isolation for the upload half of 8f-3.
 *
 * These render the REAL `Providers` — the same `QueryClient` lifecycle the app
 * has, `queryClient.clear()` on identity change included — because the bug
 * being pinned down lives exactly in the gap that `clear()` leaves open: a
 * request that was already in flight when the identity changed settles
 * afterwards, and writes into the cache that was just cleared.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: sessionState,
    reload: jest.fn(),
    setUser: jest.fn(),
    setGuest: jest.fn(),
  }),
}))

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

let sessionState: { status: string; user?: { id: string } } = {
  status: 'authenticated',
  user: { id: 'user-1' },
}

const draft = buildDraft({
  rows: [buildRow({ rowNumber: 1, status: 'READY_EXISTING_EDITION', rowVersion: 'v1' })],
})

/** A `File` whose bytes arrive only when the test lets them. */
function deferredFile(): { file: File; deliver: () => void } {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const bytes = new Uint8Array([0x69, 0x73, 0x62, 0x6e])

  return {
    file: {
      name: 'books.csv',
      size: bytes.byteLength,
      type: 'text/csv',
      arrayBuffer: async () => {
        await gate

        return bytes.buffer.slice(0)
      },
    } as unknown as File,
    deliver: () => {
      release?.()
    },
  }
}

function instantFile(): File {
  const bytes = new Uint8Array([0x69, 0x73, 0x62, 0x6e])

  return {
    name: 'books.csv',
    size: bytes.byteLength,
    type: 'text/csv',
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0)),
  } as unknown as File
}

function UploadProbe({ file }: { file: File }): ReactNode {
  const upload = useLibraryImportUpload()

  return (
    <div>
      <p data-testid="failure">{upload.uploadFailure?.kind ?? 'none'}</p>
      <p data-testid="pending">{upload.isUploading ? 'yes' : 'no'}</p>
      <button
        type="button"
        onClick={() => {
          upload.upload(file)
        }}
      >
        upload
      </button>
    </div>
  )
}

function renderProbe(file: File) {
  return render(
    <Providers>
      <UploadProbe file={file} />
    </Providers>,
  )
}

/** Lets the identity change reach `Providers` and the hook's own effect. */
async function signInAs(userId: string, view: { rerender: (ui: ReactNode) => void }, file: File) {
  sessionState = { status: 'authenticated', user: { id: userId } }
  await act(async () => {
    view.rerender(
      <Providers>
        <UploadProbe file={file} />
      </Providers>,
    )
    await Promise.resolve()
  })
}

beforeEach(() => {
  mockApiRequest.mockReset()
  mockPush.mockReset()
  sessionState = { status: 'authenticated', user: { id: 'user-1' } }
})

it('does not navigate or cache a preview that resolved after the user changed', async () => {
  let resolvePreview: ((value: unknown) => void) | undefined

  mockApiRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve
      }),
  )

  const file = instantFile()
  const view = renderProbe(file)

  act(() => {
    screen.getByRole('button', { name: 'upload' }).click()
  })
  await waitFor(() => {
    expect(resolvePreview).toBeDefined()
  })

  await signInAs('user-2', view, file)

  await act(async () => {
    resolvePreview?.(draft)
    await Promise.resolve()
  })

  // The previous person's draft neither navigates this person anywhere…
  expect(mockPush).not.toHaveBeenCalled()
  // …nor survives in the cache they are about to read.
  expect(screen.getByTestId('failure')).toHaveTextContent('none')
})

it('does not show the previous user a failure that belongs to the previous session', async () => {
  let rejectPreview: ((reason: unknown) => void) | undefined

  mockApiRequest.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectPreview = reject
      }),
  )

  const file = instantFile()
  const view = renderProbe(file)

  act(() => {
    screen.getByRole('button', { name: 'upload' }).click()
  })
  await waitFor(() => {
    expect(rejectPreview).toBeDefined()
  })

  await signInAs('user-2', view, file)

  await act(async () => {
    rejectPreview?.(new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'забагато' }))
    await Promise.resolve()
  })

  // Waits for the mutation to actually settle before asserting an absence —
  // otherwise the assertion would pass simply by running too early.
  await waitFor(() => {
    expect(screen.getByTestId('pending')).toHaveTextContent('no')
  })
  expect(screen.getByTestId('failure')).toHaveTextContent('none')
})

it('never sends a file read for a session that has since ended', async () => {
  const { file, deliver } = deferredFile()

  mockApiRequest.mockResolvedValue(draft)
  const view = renderProbe(file)

  act(() => {
    screen.getByRole('button', { name: 'upload' }).click()
  })

  // The identity changes while `arrayBuffer()` is still pending.
  await signInAs('user-2', view, file)

  await act(async () => {
    deliver()
    await Promise.resolve()
    await Promise.resolve()
  })

  // The bytes were read for the previous person; they are not uploaded as the
  // new one, so no request is made at all.
  expect(mockApiRequest).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
})

it('does not navigate after the upload screen is gone', async () => {
  let resolvePreview: ((value: unknown) => void) | undefined

  mockApiRequest.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePreview = resolve
      }),
  )

  const view = renderProbe(instantFile())

  act(() => {
    screen.getByRole('button', { name: 'upload' }).click()
  })
  await waitFor(() => {
    expect(resolvePreview).toBeDefined()
  })

  view.unmount()

  await act(async () => {
    resolvePreview?.(draft)
    await Promise.resolve()
  })

  expect(mockPush).not.toHaveBeenCalled()
})

it('still uploads and navigates for an unchanged session', async () => {
  mockApiRequest.mockResolvedValue(draft)

  renderProbe(instantFile())

  await act(async () => {
    screen.getByRole('button', { name: 'upload' }).click()
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(mockPush).toHaveBeenCalledWith('/library/imports/import-1')
  })
})
