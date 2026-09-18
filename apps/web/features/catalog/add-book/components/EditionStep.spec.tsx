/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BookLookupResult, EditionResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { EditionStep } from './EditionStep'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const createdEdition: EditionResponse = {
  edition: {
    id: 'edition-new',
    workId: 'work-1',
    translationId: 'translation-1',
    publisher: 'Виправлене видавництво',
    year: 2001,
    isbn13: '9783161484100',
    pageCount: 320,
    coverUrl: 'https://example.com/cover.jpg',
    format: 'HARDCOVER',
    lang: 'uk',
    translator: null,
    revision: 1,
  },
}

const lookup: BookLookupResult = {
  title: 'Lookup title',
  publishedYear: 2001,
  publisher: 'Видавництво з lookup',
  pageCount: 320,
  format: 'HARDCOVER',
  coverUrl: 'https://example.com/cover.jpg',
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('keeps lookup and ISBN prefill editable and submits normalized fields', async () => {
  mockApiRequest.mockResolvedValue(createdEdition)
  const onCreated = jest.fn()
  render(
    <EditionStep
      workId="work-1"
      translationId="translation-1"
      lookup={lookup}
      initialIsbn="978-3-16-148410-0"
      onCreated={onCreated}
    />,
  )
  const user = userEvent.setup()

  expect(screen.getByLabelText('Видавництво')).toHaveValue('Видавництво з lookup')
  expect(screen.getByLabelText('Рік видання')).toHaveValue(2001)
  expect(screen.getByLabelText('ISBN-13')).toHaveValue('978-3-16-148410-0')
  expect(screen.getByLabelText('Сторінок')).toHaveValue(320)
  expect(screen.getByLabelText('Палітурка')).toHaveValue('HARDCOVER')
  expect(screen.getByLabelText('Обкладинка (посилання)')).toHaveValue(
    'https://example.com/cover.jpg',
  )

  await user.clear(screen.getByLabelText('Видавництво'))
  await user.type(screen.getByLabelText('Видавництво'), 'Виправлене видавництво')
  await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/works/work-1/editions',
      expect.objectContaining({
        method: 'POST',
        body: {
          translationId: 'translation-1',
          publisher: 'Виправлене видавництво',
          year: 2001,
          isbn13: '9783161484100',
          pageCount: 320,
          coverUrl: 'https://example.com/cover.jpg',
          format: 'HARDCOVER',
        },
      }),
    )
  })
  expect(onCreated).toHaveBeenCalledWith('edition-new')
})

it('uses null for every empty optional field instead of numeric zero', async () => {
  mockApiRequest.mockResolvedValue(createdEdition)
  render(<EditionStep workId="work-1" translationId={null} onCreated={jest.fn()} />)
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/works/work-1/editions',
      expect.objectContaining({
        body: {
          translationId: null,
          publisher: null,
          year: null,
          isbn13: null,
          pageCount: null,
          coverUrl: null,
          format: 'PAPERBACK',
        },
      }),
    )
  })
})

it('shows shared validation and create-Edition API errors', async () => {
  const onCreated = jest.fn()
  render(
    <EditionStep workId="work-1" translationId={null} initialIsbn="123" onCreated={onCreated} />,
  )
  const user = userEvent.setup()

  await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))
  expect(await screen.findByText(/Некоректний ISBN-13/)).toBeInTheDocument()
  expect(mockApiRequest).not.toHaveBeenCalled()

  mockApiRequest.mockRejectedValue(
    new ApiRequestError(409, { code: 'CONFLICT', message: 'Таке видання вже існує' }),
  )
  await user.clear(screen.getByLabelText('ISBN-13'))
  await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

  expect(await screen.findByText('Таке видання вже існує')).toBeInTheDocument()
  expect(onCreated).not.toHaveBeenCalled()
})
