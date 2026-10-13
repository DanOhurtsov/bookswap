/** @jest-environment jsdom */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { ReactElement } from 'react'
import type { CatalogSearchResponse, Work, WorkAuthor, WorkPatchRequest } from '@bookswap/shared'
import type { WorkCorrectionEntity } from '../api/correction-requests'
import type { CatalogCorrection } from '../model/use-catalog-correction'
import { WorkCorrectionForm } from './WorkCorrectionForm'

/**
 * BS-76: filled Work metadata shows as text and is edited in place. Opening an editor, its own
 * «Зберегти» and «Скасувати» touch only the form draft; only the general «Зберегти» sends a PATCH.
 */
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}))

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

type User = ReturnType<typeof userEvent.setup>

const baseWork: Work = {
  id: 'work-1',
  title: 'Кобзар',
  origLang: 'uk',
  firstPubYear: null,
  description: 'Перший рядок\nДругий рядок',
  createdAt: '2024-01-01T00:00:00.000Z',
  revision: 1,
}

const shevchenko: WorkAuthor = {
  id: 'author-1',
  name: 'Тарас Шевченко',
  nameLatin: null,
  role: 'AUTHOR',
  position: 0,
}

function correction(
  submit: jest.Mock,
  over: Partial<CatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>> = {},
): CatalogCorrection<WorkPatchRequest, WorkCorrectionEntity> {
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
    ...over,
  }
}

interface FormSetup {
  work?: Work
  authors?: WorkAuthor[]
  over?: Partial<CatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>>
}

function formElement(
  submit: jest.Mock,
  { work = baseWork, authors = [shevchenko], over = {} }: FormSetup = {},
) {
  return (
    <WorkCorrectionForm
      work={work}
      authors={authors}
      correction={correction(submit, over)}
      reload={jest.fn()}
      onClose={jest.fn()}
    />
  )
}

function bodyOf(submit: jest.Mock, call = 0): WorkPatchRequest {
  return (submit.mock.calls[call] as [WorkPatchRequest])[0]
}

function editButton(label: string): HTMLElement {
  return screen.getByRole('button', { name: `Редагувати: ${label}` })
}

async function saveAll(user: User): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Зберегти' }))
}

function lastOf<T>(items: readonly T[]): T {
  const item = items[items.length - 1]

  if (item === undefined) throw new Error('expected a non-empty list')

  return item
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index]

  if (item === undefined) throw new Error(`expected an item at ${String(index)}`)

  return item
}

function authorsView(): string[] {
  return within(screen.getByRole('list'))
    .getAllByRole('listitem')
    .map((item) => item.textContent)
}

beforeEach(() => {
  jest.clearAllMocks()
})

it('заповнені поля спочатку показано текстом, порожні — дією «Додати»', () => {
  render(formElement(jest.fn()))

  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  expect(screen.getByText('Кобзар')).toBeInTheDocument()
  expect(screen.getByText('українська')).toBeInTheDocument()
  // A multi-line description keeps its own line breaks.
  expect(
    screen.getByText(
      (_, element) =>
        element?.classList.contains('inline-field__value') === true &&
        element.textContent === 'Перший рядок\nДругий рядок',
    ),
  ).toBeInTheDocument()
  expect(authorsView()).toEqual(['Тарас Шевченко — автор'])
  expect(editButton('Назва твору')).toHaveAttribute('type', 'button')
  expect(screen.getByRole('button', { name: 'Додати: Рік першого видання' })).toBeInTheDocument()
  expect(
    screen.getByText(
      'Зміни полів потрапляють у каталог лише після загальної кнопки «Зберегти» нижче.',
    ),
  ).toBeInTheDocument()
})

it('«Редагувати» й «Додати» відкривають потрібний контрол із фокусом; відкриття нічого не надсилає', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  expect(screen.getByLabelText('Назва твору')).toHaveFocus()
  expect(screen.getByLabelText('Назва твору')).toHaveValue('Кобзар')

  await user.click(screen.getByRole('button', { name: 'Скасувати: Назва твору' }))
  expect(editButton('Назва твору')).toHaveFocus()

  await user.click(editButton('Мова оригіналу'))
  expect(screen.getByLabelText('Мова оригіналу')).toHaveFocus()
  expect(screen.getByLabelText('Мова оригіналу')).toHaveValue('uk')

  await user.click(screen.getByRole('button', { name: 'Додати: Рік першого видання' }))
  expect(screen.getByLabelText('Рік першого видання')).toHaveFocus()
  expect(screen.getByLabelText('Рік першого видання')).toHaveValue(null)

  await user.click(screen.getByRole('button', { name: 'Скасувати: Рік першого видання' }))
  expect(screen.getByRole('button', { name: 'Додати: Рік першого видання' })).toHaveFocus()

  await user.click(editButton('Опис'))
  expect(screen.getByLabelText('Опис')).toHaveFocus()

  expect(submit).not.toHaveBeenCalled()

  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toEqual({
    title: 'Кобзар',
    origLang: 'uk',
    firstPubYear: null,
    description: 'Перший рядок\nДругий рядок',
    expectedRevision: 1,
  })
})

it('локальне «Зберегти» лише підтверджує поле в чернетці; повторне відкриття показує підтверджене', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Кобзар (1840)')
  await user.click(screen.getByRole('button', { name: 'Зберегти: Назва твору' }))

  expect(screen.queryByLabelText('Назва твору')).not.toBeInTheDocument()
  expect(screen.getByText('Кобзар (1840)')).toBeInTheDocument()
  expect(editButton('Назва твору')).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()

  await user.click(editButton('Назва твору'))
  expect(screen.getByLabelText('Назва твору')).toHaveValue('Кобзар (1840)')
  // Cancelling a reopened editor returns to the confirmed draft, not to the server value.
  await user.click(screen.getByRole('button', { name: 'Скасувати: Назва твору' }))
  expect(screen.getByText('Кобзар (1840)')).toBeInTheDocument()

  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ title: 'Кобзар (1840)' })
})

it('«Скасувати» відновлює значення до відкриття й не скидає змін інших полів', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(screen.getByRole('button', { name: 'Додати: Рік першого видання' }))
  await user.type(screen.getByLabelText('Рік першого видання'), '1840')
  await user.click(screen.getByRole('button', { name: 'Зберегти: Рік першого видання' }))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Чернетка, яку скасують')
  await user.click(screen.getByRole('button', { name: 'Скасувати: Назва твору' }))

  expect(screen.getByText('Кобзар')).toBeInTheDocument()
  expect(screen.getByText('1840')).toBeInTheDocument()

  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ title: 'Кобзар', firstPubYear: 1840 })
})

it('валідація: порожня назва лишає редактор відкритим із повʼязаною помилкою; очищений опис — null', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.click(screen.getByRole('button', { name: 'Зберегти: Назва твору' }))

  const titleInput = screen.getByLabelText('Назва твору')
  const error = await screen.findByText('Не вказано назву')

  expect(titleInput).toHaveAttribute('aria-invalid', 'true')
  expect(titleInput.getAttribute('aria-describedby')).toContain(error.id)
  expect(error).toHaveAttribute('role', 'alert')

  await user.click(screen.getByRole('button', { name: 'Скасувати: Назва твору' }))
  expect(screen.queryByText('Не вказано назву')).not.toBeInTheDocument()

  await user.click(editButton('Опис'))
  await user.clear(screen.getByLabelText('Опис'))
  await user.click(screen.getByRole('button', { name: 'Зберегти: Опис' }))

  expect(screen.getByRole('button', { name: 'Додати: Опис' })).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()

  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ title: 'Кобзар', description: null })
})

it('Enter у полі підтверджує саме поле, а не надсилає всю форму', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), '!{Enter}')

  expect(await screen.findByText('Кобзар!')).toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

it('загальне «Зберегти» враховує ввід у відкритому редакторі й закриває його', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Ще не підтверджена назва')
  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })
  expect(bodyOf(submit)).toMatchObject({ title: 'Ще не підтверджена назва' })
  expect(screen.queryByLabelText('Назва твору')).not.toBeInTheDocument()
  expect(screen.getByText('Ще не підтверджена назва')).toBeInTheDocument()
})

it('загальне «Зберегти» з невалідним відкритим полем: PATCH немає, помилка з фокусом на полі', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await saveAll(user)

  expect(await screen.findByText('Не вказано назву')).toBeInTheDocument()
  expect(screen.getByLabelText('Назва твору')).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()
})

it('приховане невалідне поле відкривається: твір без авторів показує редактор авторів із помилкою', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()

  render(formElement(submit, { authors: [] }))

  expect(screen.getByRole('button', { name: 'Додати автора' })).toBeInTheDocument()

  await saveAll(user)

  expect(await screen.findByText('Потрібен хоча б один автор')).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Автори' })).toBeInTheDocument()
  // No rows yet — focus goes to the editor's first control.
  expect(screen.getByRole('button', { name: 'Додати ще автора' })).toHaveFocus()
  expect(submit).not.toHaveBeenCalled()
})

it('пізня відповідь сервера не перезаписує новішого вводу, але приймає нову revision', async () => {
  const submit = jest.fn()
  const user = userEvent.setup()
  const { rerender } = render(formElement(submit))

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Перша правка')
  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(1)
  })

  await user.click(editButton('Назва твору'))
  await user.clear(screen.getByLabelText('Назва твору'))
  await user.type(screen.getByLabelText('Назва твору'), 'Друга правка')

  rerender(
    formElement(submit, {
      over: {
        justSaved: true,
        confirmed: {
          work: { ...baseWork, title: 'Перша правка', revision: 2 },
          authors: [shevchenko],
        },
      },
    }),
  )

  expect(screen.getByLabelText('Назва твору')).toHaveValue('Друга правка')

  await saveAll(user)

  await waitFor(() => {
    expect(submit).toHaveBeenCalledTimes(2)
  })
  expect(bodyOf(submit, 1)).toMatchObject({ title: 'Друга правка', expectedRevision: 2 })
})

describe('автори', () => {
  const franko = { id: 'author-existing', name: 'Іван Франко', nameLatin: null, workCount: 3 }

  function stubAuthorSearch(): void {
    mockApiRequest.mockResolvedValueOnce({
      results: [],
      authorMatches: [franko],
      page: 1,
      pageSize: 10,
      total: 0,
      hasMore: false,
    } satisfies CatalogSearchResponse)
  }

  async function addAuthorRow(user: User, name: string): Promise<void> {
    await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))

    await user.type(lastOf(screen.getAllByLabelText('Імʼя')), name)
  }

  it('редактор відкривається з фокусом на першому імені; вибраний наявний автор лишається видимим після закриття', async () => {
    const submit = jest.fn()
    const user = userEvent.setup()

    render(formElement(submit))

    await user.click(editButton('Автори'))
    expect(nth(screen.getAllByLabelText('Імʼя'), 0)).toHaveFocus()

    await addAuthorRow(user, 'Іван Фр')
    stubAuthorSearch()

    await user.click(lastOf(screen.getAllByRole('button', { name: 'Чи є такий уже в каталозі?' })))
    await user.click(await screen.findByRole('button', { name: 'Це він/вона' }))
    await user.click(screen.getByRole('button', { name: 'Зберегти: Автори' }))

    expect(authorsView()).toEqual(['Тарас Шевченко — автор', 'Іван Франко — автор'])
    expect(editButton('Автори')).toHaveFocus()

    await user.click(editButton('Автори'))
    const reopenedNames = screen.getAllByLabelText('Імʼя')

    expect(reopenedNames).toHaveLength(2)
    expect(nth(reopenedNames, 0)).toHaveValue('Тарас Шевченко')
    expect(nth(reopenedNames, 1)).toHaveValue('Іван Франко')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

    await saveAll(user)

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    // Display names never reach the strict PATCH contract.
    expect(bodyOf(submit).authors).toEqual([
      { authorId: 'author-1', role: 'AUTHOR' },
      { authorId: 'author-existing', role: 'AUTHOR' },
    ])
  })

  it('новий автор і порядок; «Скасувати» відновлює весь список — порядок, ролі й імена', async () => {
    const submit = jest.fn()
    const user = userEvent.setup()

    render(formElement(submit))

    await user.click(editButton('Автори'))
    await addAuthorRow(user, 'Новий Автор')
    await user.click(nth(screen.getAllByRole('button', { name: 'Вгору' }), 1))
    await user.click(screen.getByRole('button', { name: 'Зберегти: Автори' }))

    expect(authorsView()).toEqual(['Новий Автор — автор', 'Тарас Шевченко — автор'])

    await user.click(editButton('Автори'))
    await user.click(nth(screen.getAllByRole('button', { name: 'Прибрати' }), 0))
    await user.selectOptions(screen.getByLabelText('Роль'), 'EDITOR')
    await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

    expect(authorsView()).toEqual(['Новий Автор — автор', 'Тарас Шевченко — автор'])
    expect(editButton('Автори')).toHaveFocus()

    await saveAll(user)

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit).authors).toEqual([
      { name: 'Новий Автор', role: 'AUTHOR' },
      { authorId: 'author-1', role: 'AUTHOR' },
    ])
  })

  it('порожнє імʼя нового автора: локальне «Зберегти» показує помилку біля поля', async () => {
    const user = userEvent.setup()

    render(formElement(jest.fn()))

    await user.click(editButton('Автори'))
    await user.click(screen.getByRole('button', { name: 'Додати ще автора' }))
    await user.click(screen.getByRole('button', { name: 'Зберегти: Автори' }))

    const emptyName = lastOf(screen.getAllByLabelText('Імʼя'))

    expect(await screen.findByText('Не вказано імʼя автора')).toBeInTheDocument()
    expect(emptyName).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('group', { name: 'Автори' })).toBeInTheDocument()
  })

  it('відкриття й скасування без змін не надсилає authors', async () => {
    const submit = jest.fn()
    const user = userEvent.setup()

    render(formElement(submit))

    await user.click(editButton('Автори'))
    await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))
    await saveAll(user)

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit)).not.toHaveProperty('authors')
  })

  // Regression: an edit INSIDE an existing row (no add/remove/move) mutates the
  // form's own authors array in place — cancel must still restore the original.
  it.each([
    [
      'лише роль',
      async (user: User) => {
        await user.selectOptions(screen.getByLabelText('Роль'), 'EDITOR')
      },
    ],
    [
      'лише імʼя (рядок перемикається на нового автора)',
      async (user: User) => {
        await user.type(screen.getByLabelText('Імʼя'), ' молодший')
      },
    ],
    [
      'вибір іншого наявного автора з пошуку',
      async (user: User) => {
        stubAuthorSearch()
        await user.click(screen.getByRole('button', { name: 'Чи є такий уже в каталозі?' }))
        await user.click(await screen.findByRole('button', { name: 'Це він/вона' }))
      },
    ],
  ])(
    '«Скасувати» після зміни всередині рядка (%s) відновлює authorId, імʼя й роль; authors не надсилається',
    async (_case, change) => {
      const submit = jest.fn()
      const user = userEvent.setup()

      render(formElement(submit))

      await user.click(editButton('Автори'))
      await change(user)
      await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

      expect(authorsView()).toEqual(['Тарас Шевченко — автор'])

      await user.click(editButton('Автори'))
      expect(screen.getByLabelText('Імʼя')).toHaveValue('Тарас Шевченко')
      expect(screen.getByLabelText('Роль')).toHaveValue('AUTHOR')
      await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

      await saveAll(user)

      await waitFor(() => {
        expect(submit).toHaveBeenCalledTimes(1)
      })
      expect(bodyOf(submit)).not.toHaveProperty('authors')
    },
  )

  it('редактор, відкритий під час збереження: скасування після відповіді не створює автора вдруге', async () => {
    const submit = jest.fn()
    const user = userEvent.setup()
    const { rerender } = render(formElement(submit))

    await user.click(editButton('Автори'))
    await addAuthorRow(user, 'Новий Автор')
    await saveAll(user)

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(1)
    })
    expect(bodyOf(submit).authors).toEqual([
      { authorId: 'author-1', role: 'AUTHOR' },
      { name: 'Новий Автор', role: 'AUTHOR' },
    ])

    // Opened while the PATCH is still in flight — its snapshot holds the new NAME.
    await user.click(editButton('Автори'))

    const created: WorkAuthor = {
      id: 'author-new-1',
      name: 'Новий Автор',
      nameLatin: null,
      role: 'AUTHOR',
      position: 1,
    }
    const confirmedAuthors = [shevchenko, created]

    rerender(
      formElement(submit, {
        authors: confirmedAuthors,
        over: {
          justSaved: true,
          confirmed: { work: { ...baseWork, revision: 2 }, authors: confirmedAuthors },
        },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))

    expect(authorsView()).toEqual(['Тарас Шевченко — автор', 'Новий Автор — автор'])

    await saveAll(user)

    await waitFor(() => {
      expect(submit).toHaveBeenCalledTimes(2)
    })
    expect(bodyOf(submit, 1)).not.toHaveProperty('authors')
    expect(bodyOf(submit, 1)).toMatchObject({ expectedRevision: 2 })
  })

  // Regression: what the form holds and what was sent can differ only in key
  // order (`{ name, role, nameLatin }` vs zod's `{ name, nameLatin, role }`)
  // or in whitespace zod trims — neither may block adopting server ids.
  describe.each([
    ['з латиницею', { typed: 'Новий Автор', latin: 'Novyi Avtor' }],
    ['з пробілом у кінці імені', { typed: 'Новий Автор ', latin: undefined }],
  ])('новий автор %s', (_case, { typed, latin }) => {
    const created: WorkAuthor = {
      id: 'author-new-1',
      name: 'Новий Автор',
      nameLatin: latin ?? null,
      role: 'AUTHOR',
      position: 1,
    }
    const confirmedAuthors = [shevchenko, created]

    async function addAndSave(user: User, submit: jest.Mock): Promise<void> {
      await user.click(editButton('Автори'))
      await addAuthorRow(user, typed)

      if (latin !== undefined) {
        // Pasted in one go: the field trims on every keystroke (known, separate issue).
        await user.click(lastOf(screen.getAllByLabelText('Латиницею (необовʼязково)')))
        await user.paste(latin)
      }

      await saveAll(user)
      await waitFor(() => {
        expect(submit).toHaveBeenCalledTimes(1)
      })
      expect(bodyOf(submit).authors).toEqual([
        { authorId: 'author-1', role: 'AUTHOR' },
        {
          name: 'Новий Автор',
          ...(latin === undefined ? {} : { nameLatin: latin }),
          role: 'AUTHOR',
        },
      ])
    }

    function confirmSave(rerender: (ui: ReactElement) => void, submit: jest.Mock): void {
      rerender(
        formElement(submit, {
          authors: confirmedAuthors,
          over: {
            justSaved: true,
            confirmed: { work: { ...baseWork, revision: 2 }, authors: confirmedAuthors },
          },
        }),
      )
    }

    async function saveTitleOnly(user: User, submit: jest.Mock): Promise<void> {
      await user.click(editButton('Назва твору'))
      await user.type(screen.getByLabelText('Назва твору'), ' (виправлено)')
      await saveAll(user)
      await waitFor(() => {
        expect(submit).toHaveBeenCalledTimes(2)
      })
      expect(bodyOf(submit, 1)).not.toHaveProperty('authors')
      expect(bodyOf(submit, 1)).toMatchObject({ title: 'Кобзар (виправлено)', expectedRevision: 2 })
    }

    it('успіх → зміна лише назви → PATCH без authors', async () => {
      const submit = jest.fn()
      const user = userEvent.setup()
      const { rerender } = render(formElement(submit))

      await addAndSave(user, submit)
      confirmSave(rerender, submit)
      await saveTitleOnly(user, submit)
    })

    it('редактор відкрито під час PATCH, «Скасувати» після відповіді → PATCH без authors', async () => {
      const submit = jest.fn()
      const user = userEvent.setup()
      const { rerender } = render(formElement(submit))

      await addAndSave(user, submit)
      await user.click(editButton('Автори'))
      confirmSave(rerender, submit)
      await user.click(screen.getByRole('button', { name: 'Скасувати: Автори' }))
      await saveTitleOnly(user, submit)
    })
  })
})
