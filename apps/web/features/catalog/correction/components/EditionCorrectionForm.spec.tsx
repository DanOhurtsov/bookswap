/** @jest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Edition, EditionPatchRequest } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { chooseOption, searchAndChooseOption } from '@/components/Form/test-choose-option'
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

  expect(screen.getByRole('combobox', { name: 'Палітурка' })).toHaveTextContent('Не вказано')
  expect(screen.getByRole('combobox', { name: 'Що відомо про текст видання' })).toHaveTextContent(
    'Невідомо: оригінал чи переклад',
  )
  expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('Не вказано')

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
  await chooseOption(user, 'Що відомо про текст видання', 'Оригінал')
  await searchAndChooseOption(user, 'Мова видання', 'укра', 'українська')
  // Asserted while the editor is open: the general save closes it.
  expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('українська')
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
  await chooseOption(user, 'Що відомо про текст видання', 'Оригінал')
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

describe('селектори в inline-редакторах (BS-92)', () => {
  const translation = {
    workId: 'w-1',
    translator: 'Олена Оніщук',
    lang: 'uk',
    sourceLang: 'en',
    year: null,
    isAbridged: false,
    hasNotes: false,
    notes: null,
    editionCount: 1,
    revision: 1,
  }
  const languageSearch = () => screen.findByRole('combobox', { name: 'Пошук: Мова видання' })

  it('відкритий редактор фокусує сам селектор, а не приховане поле форми', async () => {
    const user = userEvent.setup()

    renderForm(jest.fn())
    await openField(user, 'Мова видання')

    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveFocus()
  })

  it('Enter у пошуку вибирає мову, але не підтверджує поле й нічого не надсилає', async () => {
    const user = userEvent.setup()
    const submit = jest.fn()

    renderForm(submit)
    await openField(user, 'Мова видання')
    await user.keyboard('{Enter}')
    await languageSearch()
    await user.keyboard('пол{Enter}')

    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('польська')
    expect(screen.getByRole('button', { name: 'Зберегти: Мова видання' })).toBeInTheDocument()

    // No match to pick: Enter neither changes the value nor confirms the field.
    await user.keyboard('{Enter}')
    await languageSearch()
    await user.keyboard('клінгонська{Enter}')

    expect(screen.getByRole('button', { name: 'Зберегти: Мова видання' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('польська')
    expect(submit).not.toHaveBeenCalled()
  })

  it('Escape у списку закриває лише список: редактор лишається з попереднім значенням', async () => {
    const user = userEvent.setup()

    renderForm(jest.fn(), { lang: 'vi' })
    await openField(user, 'Мова видання')
    await user.keyboard('{Enter}')
    await languageSearch()
    await user.keyboard('пол{Escape}')

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveFocus()
    })
    expect(screen.getByRole('combobox', { name: 'Мова видання' })).toHaveTextContent('вʼєтнамська')
    expect(screen.getByRole('button', { name: 'Скасувати: Мова видання' })).toBeInTheDocument()
  })

  it('підтвердження поля змінює чернетку, а в каталог вона йде лише загальною кнопкою', async () => {
    const user = userEvent.setup()
    const submit = jest.fn()

    renderForm(submit)
    await openField(user, 'Мова видання')
    await searchAndChooseOption(user, 'Мова видання', 'Нім', 'німецька')
    await user.click(screen.getByRole('button', { name: 'Зберегти: Мова видання' }))

    expect(screen.getByText('німецька')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Редагувати: Мова видання' })).toHaveFocus()
    expect(submit).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit)).toMatchObject({ lang: 'de' })
  })

  it('«Скасувати» повертає мову, яка була до відкриття редактора, і вона не надсилається', async () => {
    const user = userEvent.setup()
    const submit = jest.fn()

    renderForm(submit, { lang: 'en' })
    await openField(user, 'Мова видання')
    await chooseOption(user, 'Мова видання', 'польська')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Мова видання' }))

    expect(screen.getByText('англійська')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit)).not.toHaveProperty('lang')
  })

  it('переклад вибирається за ID, навіть коли два переклади названі однаково', async () => {
    const user = userEvent.setup()
    const submit = jest.fn()

    render(
      <EditionCorrectionForm
        edition={edition}
        translations={[
          { ...translation, id: 't-1' },
          { ...translation, id: 't-2' },
        ]}
        correction={correction(submit)}
        reload={jest.fn()}
        onClose={jest.fn()}
      />,
    )
    await openField(user, 'Переклад')
    await user.click(screen.getByRole('combobox', { name: 'Переклад' }))
    await screen.findByRole('combobox', { name: 'Пошук: Переклад' })
    await user.keyboard('оніщ')

    const [, second] = screen.getAllByRole('option', { name: 'Олена Оніщук (українська)' })

    await user.click(second as HTMLElement)
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit)).toMatchObject({ translationId: 't-2' })
  })

  it('«Без привʼязки до перекладу» надсилає null, а не порожній рядок', async () => {
    const user = userEvent.setup()
    const submit = jest.fn()

    render(
      <EditionCorrectionForm
        edition={{ ...edition, translationId: 't-1', textKind: 'TRANSLATION' }}
        translations={[{ ...translation, id: 't-1' }]}
        correction={correction(submit)}
        reload={jest.fn()}
        onClose={jest.fn()}
      />,
    )
    await openField(user, 'Переклад')
    await chooseOption(user, 'Переклад', 'Без привʼязки до перекладу')
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit)).toMatchObject({ translationId: null })
  })
})
