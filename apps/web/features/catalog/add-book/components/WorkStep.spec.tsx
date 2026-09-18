/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BookLookupResult, WorkDetailResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { WorkStep } from './WorkStep'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const createdWork: WorkDetailResponse = {
  work: {
    id: 'work-new',
    title: 'Новий твір',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  translations: [],
  editions: [],
}

function renderWork(initialTitle = 'Новий твір', lookup?: BookLookupResult) {
  const onCreated = jest.fn()
  render(<WorkStep initialTitle={initialTitle} lookup={lookup} onCreated={onCreated} />)

  return onCreated
}

function itemAt<T>(values: readonly T[], index: number): T {
  const value = values[index]
  if (value === undefined) throw new Error(`Missing test item at index ${String(index)}`)
  return value
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('keeps lookup title and author order editable without treating the edition year as a Work year', async () => {
  const lookup: BookLookupResult = {
    title: 'Назва з lookup',
    authors: ['Автор Один', 'Автор Два'],
    publishedYear: 2001,
    description: 'Опис із зовнішнього каталогу',
  }
  const user = userEvent.setup()
  renderWork('ISBN query', lookup)

  expect(screen.getByLabelText('Назва твору')).toHaveValue('Назва з lookup')
  expect(screen.getByLabelText('Рік першого видання')).toHaveValue(null)
  expect(screen.getByLabelText('Опис')).toHaveValue('Опис із зовнішнього каталогу')
  const authorNames = screen.getAllByLabelText('Імʼя')
  expect(authorNames).toHaveLength(2)
  expect(itemAt(authorNames, 0)).toHaveValue('Автор Один')
  expect(itemAt(authorNames, 1)).toHaveValue('Автор Два')

  await user.click(itemAt(screen.getAllByRole('button', { name: 'Прибрати' }), 0))
  expect(screen.getAllByLabelText('Імʼя')).toHaveLength(1)
  expect(screen.getByLabelText('Імʼя')).toHaveValue('Автор Два')

  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Виправлена назва')
  expect(screen.getByLabelText('Назва твору')).toHaveValue('Виправлена назва')
})

it('preserves field-array order and roles for existing and new authors', async () => {
  mockApiRequest.mockImplementation((path: string) => {
    if (path.startsWith('/catalog/search')) {
      return Promise.resolve({
        workMatches: [],
        authorMatches: [
          { id: 'author-existing', name: 'Тарас Шевченко', nameLatin: null, workCount: 12 },
        ],
      })
    }

    return Promise.resolve(createdWork)
  })

  const onCreated = renderWork()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Імʼя'), 'Тарас')
  await user.click(screen.getByRole('button', { name: 'Чи є такий уже?' }))
  await user.click(await screen.findByRole('button', { name: 'Це він/вона' }))
  await user.selectOptions(screen.getByLabelText('Роль'), 'EDITOR')

  await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))
  await user.type(itemAt(screen.getAllByLabelText('Імʼя'), 1), 'Леся Українка')
  await user.selectOptions(itemAt(screen.getAllByLabelText('Роль'), 1), 'CO_AUTHOR')
  await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/works',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          firstPubYear: null,
          authors: [
            { authorId: 'author-existing', role: 'EDITOR' },
            { name: 'Леся Українка', role: 'CO_AUTHOR' },
          ],
        }),
      }),
    )
  })
  expect(onCreated).toHaveBeenCalledWith('work-new', 'Новий твір')
})

it('turns an edited catalog selection back into a new author', async () => {
  mockApiRequest.mockImplementation((path: string) => {
    return path.startsWith('/catalog/search')
      ? Promise.resolve({
          workMatches: [],
          authorMatches: [
            { id: 'author-existing', name: 'Тарас Шевченко', nameLatin: null, workCount: 12 },
          ],
        })
      : Promise.resolve(createdWork)
  })

  renderWork()
  const user = userEvent.setup()
  const name = screen.getByLabelText('Імʼя')
  await user.type(name, 'Тарас')
  await user.click(screen.getByRole('button', { name: 'Чи є такий уже?' }))
  await user.click(await screen.findByRole('button', { name: 'Це він/вона' }))
  expect(screen.getByText('Вибрано наявного автора з каталогу.')).toBeInTheDocument()

  await user.clear(name)
  await user.type(name, 'Новий Автор')
  await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

  await waitFor(() => {
    expect(mockApiRequest).toHaveBeenCalledWith(
      '/works',
      expect.objectContaining({
        body: expect.objectContaining({ authors: [{ name: 'Новий Автор', role: 'AUTHOR' }] }),
      }),
    )
  })
})

it('keeps author-search API failure non-blocking', async () => {
  mockApiRequest.mockRejectedValue(new Error('offline'))
  renderWork()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Імʼя'), 'Невідомий')
  await user.click(screen.getByRole('button', { name: 'Чи є такий уже?' }))

  expect(
    await screen.findByText('Схожих авторів не знайшлося — буде створено нового.'),
  ).toBeInTheDocument()
})

it('shows shared-contract validation and preserves a create-Work API error', async () => {
  const user = userEvent.setup()
  renderWork('')
  await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

  expect(await screen.findByText('Не вказано назву')).toBeInTheDocument()
  expect(screen.getByText('Не вказано імʼя автора')).toBeInTheDocument()
  expect(mockApiRequest).not.toHaveBeenCalled()

  mockApiRequest.mockRejectedValue(
    new ApiRequestError(409, { code: 'CONFLICT', message: 'Такий твір уже існує' }),
  )
  await user.type(screen.getByLabelText('Назва твору'), 'Дюна')
  await user.type(screen.getByLabelText('Імʼя'), 'Френк Герберт')
  await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

  expect(await screen.findByText('Такий твір уже існує')).toBeInTheDocument()
})
