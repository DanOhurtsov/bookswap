/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Translation, TranslationPatchRequest } from '@bookswap/shared'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { TranslationCorrectionForm } from './TranslationCorrectionForm'

/**
 * BS-76 for a translation: booleans and languages read as words, `false` is not treated as
 * empty, an editor opens from the keyboard, and only the form's own «Зберегти» sends a PATCH.
 */
const translation: Translation = {
  id: 't-1',
  workId: 'w-1',
  translator: 'John Weston',
  lang: 'en',
  sourceLang: 'uk',
  year: null,
  isAbridged: false,
  hasNotes: true,
  notes: 'Коментарі до\nкожного розділу',
  editionCount: 1,
  revision: 4,
}

function correction(submit: jest.Mock): CatalogCorrection<TranslationPatchRequest, Translation> {
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

function renderForm(submit: jest.Mock) {
  return render(
    <TranslationCorrectionForm
      translation={translation}
      correction={correction(submit)}
      reload={jest.fn()}
      onClose={jest.fn()}
    />,
  )
}

function bodyOf(submit: jest.Mock): TranslationPatchRequest {
  return (submit.mock.calls[0] as [TranslationPatchRequest])[0]
}

it('false — це значення «ні», а не порожнє поле; мови — назвами', () => {
  renderForm(jest.fn())

  expect(
    screen.getByRole('button', { name: 'Редагувати: Скорочений переклад' }),
  ).toBeInTheDocument()
  expect(screen.getByText('ні')).toBeInTheDocument()
  expect(screen.getByText('так')).toBeInTheDocument()
  expect(screen.getByText('англійська')).toBeInTheDocument()
  expect(screen.getByText('українська')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Додати: Рік перекладу' })).toBeInTheDocument()
})

it('з клавіатури: Enter відкриває чекбокс із фокусом, Space перемикає, підтвердження повертає фокус', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)

  const editAbridged = screen.getByRole('button', { name: 'Редагувати: Скорочений переклад' })

  editAbridged.focus()
  await user.keyboard('{Enter}')

  const checkbox = screen.getByLabelText('Скорочений переклад')

  expect(checkbox).toHaveFocus()
  expect(checkbox).not.toBeChecked()

  await user.keyboard(' ')
  expect(checkbox).toBeChecked()

  await user.tab()
  expect(screen.getByRole('button', { name: 'Зберегти: Скорочений переклад' })).toHaveFocus()
  await user.keyboard(' ')

  expect(screen.getByRole('button', { name: 'Редагувати: Скорочений переклад' })).toHaveFocus()
  expect(screen.getAllByText('так')).toHaveLength(2)
  expect(submit).not.toHaveBeenCalled()
})

it('скасування чекбокса повертає попереднє значення; очищені примітки надсилаються як null', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)

  await user.click(
    screen.getByRole('button', { name: 'Редагувати: Є примітки й коментарі перекладача' }),
  )
  await user.click(screen.getByLabelText('Є примітки й коментарі перекладача'))
  await user.click(
    screen.getByRole('button', { name: 'Скасувати: Є примітки й коментарі перекладача' }),
  )

  expect(screen.getByText('так')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Редагувати: Примітки' }))
  expect(screen.getByLabelText('Примітки')).toHaveValue('Коментарі до\nкожного розділу')
  await user.clear(screen.getByLabelText('Примітки'))
  await user.click(screen.getByRole('button', { name: 'Зберегти: Примітки' }))

  expect(screen.getByRole('button', { name: 'Додати: Примітки' })).toHaveFocus()

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toEqual({
    translator: 'John Weston',
    lang: 'en',
    sourceLang: 'uk',
    year: null,
    isAbridged: false,
    hasNotes: true,
    notes: null,
    expectedRevision: 4,
  })
})

it('невалідний рік у відкритому редакторі зупиняє загальне збереження з помилкою біля поля', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)

  await user.click(screen.getByRole('button', { name: 'Додати: Рік перекладу' }))
  await user.type(screen.getByLabelText('Рік перекладу'), '99999')
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(screen.getByLabelText('Рік перекладу')).toHaveAttribute('aria-invalid', 'true')
  })
  expect(screen.getByLabelText('Рік перекладу')).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()
})
