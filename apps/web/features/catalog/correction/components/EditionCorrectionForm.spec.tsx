/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Edition, EditionPatchRequest } from '@bookswap/shared'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { EditionCorrectionForm } from './EditionCorrectionForm'

/**
 * Форма виправлення видання з невідомими даними (docs/plan/fast-book-add.md, §4; ред. 2): порожня палітурка
 * не вигадується й не надсилається, а тип тексту й мова йдуть у запит лише коли людина їх змінила —
 * інакше збереження видавництва могло б перезаписати те, що сервер вивів зі зміни перекладу.
 */
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

const edition: Edition = {
  id: 'e-1',
  workId: 'w-1',
  translationId: null,
  textKind: 'UNKNOWN',
  publisher: null,
  year: null,
  isbn13: null,
  pageCount: null,
  coverUrl: null,
  format: null,
  lang: null,
  translator: null,
  revision: 3,
}

function correction(submit: jest.Mock): CatalogCorrection<EditionPatchRequest, Edition> {
  return {
    overlay: undefined,
    saveError: undefined,
    justSaved: false,
    confirmed: undefined,
    refreshNotice: undefined,
    isSaving: false,
    submit,
    dismissRefreshNotice: jest.fn(),
    resolve: (fresh) => fresh,
  }
}

function renderForm(submit: jest.Mock, over: Partial<Edition> = {}) {
  return render(
    <EditionCorrectionForm
      edition={{ ...edition, ...over }}
      translations={[]}
      correction={correction(submit)}
      reload={jest.fn()}
      onClose={jest.fn()}
    />,
  )
}

function bodyOf(submit: jest.Mock): Record<string, unknown> {
  return (submit.mock.calls[0] as [Record<string, unknown>])[0]
}

it('невідомий формат: порожній вибір «Не вказано», і збереження видавництва не надсилає формат, тип тексту чи мову', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)

  expect(screen.getByLabelText('Палітурка')).toHaveValue('')
  expect(screen.getByLabelText('Що відомо про текст видання')).toHaveValue('UNKNOWN')
  expect(screen.getByLabelText('Мова видання')).toHaveValue('')

  await user.type(screen.getByLabelText('Видавництво'), 'КСД')
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ publisher: 'КСД', expectedRevision: 3 })
  expect(bodyOf(submit)).not.toHaveProperty('format')
  expect(bodyOf(submit)).not.toHaveProperty('textKind')
  expect(bodyOf(submit)).not.toHaveProperty('lang')
})

it('змінені тип тексту й мова видання потрапляють у запит; мова вибирається за назвою', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)
  await user.selectOptions(screen.getByLabelText('Що відомо про текст видання'), 'ORIGINAL')
  await user.selectOptions(screen.getByLabelText('Мова видання'), 'uk')
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ textKind: 'ORIGINAL', lang: 'uk' })
  expect(screen.getByRole('option', { name: 'українська' })).toBeInTheDocument()
})

it('відома палітурка лишається вибраною й передається', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit, { format: 'HARDCOVER', textKind: 'ORIGINAL', lang: 'uk' })
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ format: 'HARDCOVER' })
})
