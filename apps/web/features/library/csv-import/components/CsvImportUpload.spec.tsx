/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TextEncoder } from 'node:util'
import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { withQueryClient } from '@/app/lib/test-query-client'
import { buildDraft, buildRow } from '../library-import.test-helpers'
import { CsvImportUpload } from './CsvImportUpload'

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

const mockPush = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const draft = buildDraft({
  rows: [buildRow({ rowNumber: 1, status: 'READY_EXISTING_EDITION', rowVersion: 'v1' })],
})

function csvFile(bytes: Uint8Array, name = 'books.csv'): File {
  return {
    name,
    size: bytes.byteLength,
    type: 'text/csv',
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as File
}

function choose(file: File): void {
  const input = screen.getByLabelText('Файл CSV')

  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  fireEvent.change(input)
}

beforeEach(() => {
  mockApiRequest.mockReset()
  mockPush.mockReset()
})

it('states the shared limits rather than hard-coded numbers', () => {
  render(withQueryClient(<CsvImportUpload />))

  expect(screen.getByText(/48 КіБ/)).toBeInTheDocument()
  expect(
    screen.getByText(new RegExp(String(LIBRARY_IMPORT_LIMITS.maxDataRows))),
  ).toBeInTheDocument()
  expect(screen.getByText(new RegExp(String(LIBRARY_IMPORT_LIMITS.maxCopies)))).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'шаблон CSV' })).toHaveAttribute(
    'href',
    '/library-import-template.csv',
  )
})

it('sends the file bytes as base64 and opens the draft by its own URL', async () => {
  mockApiRequest.mockResolvedValue(draft)
  render(withQueryClient(<CsvImportUpload />))

  choose(csvFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x73, 0x62, 0x6e])))
  await act(async () => {
    screen.getByRole('button', { name: 'Перевірити файл' }).click()
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/me/library/imports/preview',
      expect.objectContaining({ method: 'POST', body: { contentBase64: '77u/aXNibg==' } }),
    )
  })
  await waitFor(() => {
    expect(mockPush).toHaveBeenCalledWith('/library/imports/import-1')
  })
})

it('refuses an oversized file locally, without a request', async () => {
  render(withQueryClient(<CsvImportUpload />))

  choose(csvFile(new Uint8Array(LIBRARY_IMPORT_LIMITS.maxBytes + 1)))
  await act(async () => {
    screen.getByRole('button', { name: 'Перевірити файл' }).click()
    await Promise.resolve()
  })

  expect(await screen.findByText(/Файл завеликий/)).toBeInTheDocument()
  expect(mockApiRequest).not.toHaveBeenCalled()
})

it('explains a server-side CSV error in words', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(400, {
      code: 'IMPORT_INVALID_CSV',
      message: 'Файл не є коректним CSV імпорту',
      details: {
        reason: 'HEADER_MISMATCH',
        missingColumns: ['title'],
        duplicateColumns: [],
        unknownColumnPositions: [3],
        orderMismatch: false,
      },
    }),
  )
  render(withQueryClient(<CsvImportUpload />))

  choose(csvFile(new TextEncoder().encode('bad,header\n')))
  await act(async () => {
    screen.getByRole('button', { name: 'Перевірити файл' }).click()
    await Promise.resolve()
  })

  expect(await screen.findByText(/Заголовок файла не збігається з шаблоном/)).toBeInTheDocument()
  expect(mockPush).not.toHaveBeenCalled()
})

it('shows rate limiting as its own state with an explicit retry', async () => {
  mockApiRequest.mockRejectedValue(
    new ApiRequestError(429, { code: 'TOO_MANY_REQUESTS', message: 'Забагато запитів' }),
  )
  render(withQueryClient(<CsvImportUpload />))

  choose(csvFile(new TextEncoder().encode('isbn13\n')))
  await act(async () => {
    screen.getByRole('button', { name: 'Перевірити файл' }).click()
    await Promise.resolve()
  })

  expect(await screen.findByText(/Забагато запитів поспіль/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Спробувати ще раз' })).toBeInTheDocument()
})

it('turns two submits in one batch into a single preview request', async () => {
  mockApiRequest.mockResolvedValue(draft)
  render(withQueryClient(<CsvImportUpload />))

  choose(csvFile(new TextEncoder().encode('isbn13\n')))
  const submit = screen.getByRole('button', { name: 'Перевірити файл' })

  await act(async () => {
    submit.click()
    submit.click()
    await Promise.resolve()
  })

  await waitFor(() => {
    expect(mockPush).toHaveBeenCalled()
  })
  expect(mockApiRequest).toHaveBeenCalledTimes(1)
})
