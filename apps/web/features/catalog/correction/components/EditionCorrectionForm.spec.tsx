/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Edition, EditionPatchRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
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

/** BS-76: a field shows as text (or «Додати» when empty) until its own editor is opened. */
async function openField(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await user.click(
    screen.getByRole('button', { name: new RegExp(`^(Редагувати|Додати): ${label}$`) }),
  )
}

function bodyOf(submit: jest.Mock): Record<string, unknown> {
  return (submit.mock.calls[0] as [Record<string, unknown>])[0]
}

it('невідомий формат: порожній вибір «Не вказано», і збереження видавництва не надсилає формат, тип тексту чи мову', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)
  await openField(user, 'Палітурка')
  await openField(user, 'Що відомо про текст видання')
  await openField(user, 'Мова видання')

  expect(screen.getByLabelText('Палітурка')).toHaveValue('')
  expect(screen.getByLabelText('Що відомо про текст видання')).toHaveValue('UNKNOWN')
  expect(screen.getByLabelText('Мова видання')).toHaveValue('')

  await openField(user, 'Видавництво')
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
  await openField(user, 'Що відомо про текст видання')
  await openField(user, 'Мова видання')
  await user.selectOptions(screen.getByLabelText('Що відомо про текст видання'), 'ORIGINAL')
  await user.selectOptions(screen.getByLabelText('Мова видання'), 'uk')
  // Asserted while the editor is open: the general save closes it.
  expect(screen.getByRole('option', { name: 'українська' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ textKind: 'ORIGINAL', lang: 'uk' })
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

it('відкритий і скасований тип тексту лишається незміненим і не потрапляє в запит', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  renderForm(submit)
  await openField(user, 'Що відомо про текст видання')
  await user.selectOptions(screen.getByLabelText('Що відомо про текст видання'), 'ORIGINAL')
  await user.click(screen.getByRole('button', { name: 'Скасувати: Що відомо про текст видання' }))

  expect(screen.getByText('Невідомо: оригінал чи переклад')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Зберегти' }))

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).not.toHaveProperty('textKind')
})

it('переклад, палітурка й мова видання показані назвами; посилання на обкладинку — текстом', () => {
  render(
    <EditionCorrectionForm
      edition={{
        ...edition,
        translationId: 't-1',
        textKind: 'TRANSLATION',
        lang: 'en',
        format: 'PAPERBACK',
        coverUrl: 'https://example.com/a/very/long/cover/path.jpg',
      }}
      translations={[
        {
          id: 't-1',
          workId: 'w-1',
          translator: 'John Weston',
          lang: 'en',
          sourceLang: 'uk',
          year: null,
          isAbridged: false,
          hasNotes: false,
          notes: null,
          editionCount: 1,
          revision: 1,
        },
      ]}
      correction={correction(jest.fn())}
      reload={jest.fn()}
      onClose={jest.fn()}
    />,
  )

  expect(screen.getByText('John Weston (англійська)')).toBeInTheDocument()
  expect(screen.getByText('мʼяка')).toBeInTheDocument()
  expect(screen.getByText('англійська')).toBeInTheDocument()
  expect(screen.getByText('https://example.com/a/very/long/cover/path.jpg')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Додати: Видавництво' })).toBeInTheDocument()
})

it('зайнятий ISBN від сервера видно й у текстовому вигляді поля, повʼязано з кнопкою редагування', () => {
  render(
    <EditionCorrectionForm
      edition={{ ...edition, isbn13: '9786170000000' }}
      translations={[]}
      correction={{
        ...correction(jest.fn()),
        saveError: new ApiRequestError(409, {
          code: 'EDITION_ISBN_TAKEN',
          message: 'Видання з таким ISBN уже є',
        }),
      }}
      reload={jest.fn()}
      onClose={jest.fn()}
    />,
  )

  const error = screen.getByText('Видання з таким ISBN уже є')

  expect(error).toHaveAttribute('role', 'alert')
  expect(screen.getByRole('button', { name: 'Редагувати: ISBN-13' })).toHaveAttribute(
    'aria-describedby',
    error.id,
  )
})
