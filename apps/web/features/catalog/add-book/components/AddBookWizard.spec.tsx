/** @jest-environment jsdom */

import { StrictMode } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { Edition, Translation, Work, WorkAuthor, WorkDetailResponse } from '@bookswap/shared'
import { createTestQueryClient, withQueryClient } from '@/app/lib/test-query-client'
import { stashExternalSelection } from '../model/external-handoff'
import { AddBookWizard } from './AddBookWizard'

/**
 * Компонентні тести на чотири гілки флоу (Етап 7d, DoD):
 *
 * 1. крок 1 — пошук, показ кандидатів;
 * 2. гілка «наявне Edition» — лише `Copy`;
 * 3. гілка «наявне Work» — нове `Edition` (+ `Translation` за потреби);
 * 4. гілка «немає збігів» — повний ланцюг, з чернеткою з lookup, яка
 *    залишається редагованою, і зрозумілими повідомленнями на 429/504/помилку
 *    провайдера.
 *
 * `apiRequest` мокається цілим модулем (`ApiRequestError`/`describeError` —
 * реальні), бо саме через нього йдуть усі виклики бекенду з усіх кроків
 * майстра. Сесія й роутер мокаються окремо: це не предмет цього тесту.
 */

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

/**
 * `BarcodeScannerPanel` has its own dedicated spec covering camera
 * lifecycle/errors — here it's replaced by a deterministic stand-in so these
 * tests exercise only the entry-method threading contract end to end.
 * Mocked by the named loader module — see `SearchStep.spec.tsx` for why.
 */
jest.mock('../lib/load-barcode-scanner-panel', () => ({
  loadBarcodeScannerPanel: () =>
    Promise.resolve(({ onValidIsbn }: { onValidIsbn: (isbn: string) => void }) => (
      <button type="button" onClick={() => onValidIsbn('9783161484100')}>
        Simulate scan
      </button>
    )),
}))

jest.mock('@/app/lib/use-session', () => ({
  useSession: () => ({
    state: { status: 'authenticated', user: { id: 'me', name: 'Тест', email: 't@example.com' } },
    reload: jest.fn(),
    setUser: jest.fn(),
  }),
}))

let searchParams = new URLSearchParams()
const push = jest.fn()
const replace = jest.fn()

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchParams,
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

/** Валідний ISBN-13 (перевірено `isValidIsbn13`): 978-3-16-148410 + контрольна цифра 0. */
const CANDIDATE_ISBN = '9783161484100'

function work(overrides: Partial<Work> = {}): Work {
  return {
    id: 'work-1',
    title: 'Кобзар',
    origLang: 'uk',
    firstPubYear: 1840,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    ...overrides,
  }
}

function author(overrides: Partial<WorkAuthor> = {}): WorkAuthor {
  return {
    id: 'author-1',
    name: 'Тарас Шевченко',
    nameLatin: null,
    role: 'AUTHOR',
    position: 0,
    ...overrides,
  }
}

function edition(overrides: Partial<Edition> = {}): Edition {
  return {
    id: 'edition-1',
    workId: 'work-1',
    translationId: null,
    publisher: 'Наука',
    year: 2019,
    isbn13: null,
    pageCount: 320,
    coverUrl: null,
    format: 'HARDCOVER',
    lang: 'uk',
    translator: null,
    revision: 1,
    ...overrides,
  }
}

function translation(overrides: Partial<Translation> = {}): Translation {
  return {
    id: 'translation-1',
    workId: 'work-1',
    translator: 'Тестовий Перекладач',
    lang: 'de',
    sourceLang: 'en',
    year: null,
    isAbridged: false,
    hasNotes: false,
    notes: null,
    editionCount: 0,
    revision: 1,
    ...overrides,
  }
}

function candidate(overrides: Partial<WorkDetailResponse> = {}): WorkDetailResponse {
  return { work: work(), authors: [author()], translations: [], editions: [], ...overrides }
}

/**
 * Не HTTP-клієнт, а маршрутизатор фейкових відповідей за шляхом запиту.
 *
 * Найдовший збіг префікса, а не перший-у-порядку-оголошення: інакше `/works`
 * (створення `Work`) перехопив би виклик `/works/:id/editions` (створення
 * `Edition`), бо другий шлях теж починається з першого.
 */
/**
 * Stage 8h-2: the success step shows the activation checklist, which reads
 * `/me/activation` through this same transport. Routed here once rather than in
 * every test — no test in this file is about the checklist, they are about the
 * wizard's branches, and an unrouted path throws by design below.
 */
const ACTIVATION_PROGRESS = {
  ownedCopyCount: 2,
  target: 10,
  hasReachedTarget: false,
  nextAction: 'ADD_BOOKS',
} as const

function routeApiRequest(handlers: Record<string, (options: { body?: unknown }) => unknown>): void {
  const byLength = Object.entries(handlers)
    .concat([['/me/activation', () => ACTIVATION_PROGRESS]])
    .sort(([a], [b]) => b.length - a.length)

  mockApiRequest.mockImplementation(async (path: string, options: { body?: unknown } = {}) => {
    const match = byLength.find(([prefix]) => path.startsWith(prefix))

    if (match === undefined) throw new Error(`Немає фейкової відповіді для ${path}`)

    return match[1](options)
  })
}

beforeEach(() => {
  searchParams = new URLSearchParams()
  mockApiRequest.mockReset()
  push.mockReset()
  replace.mockReset()
  sessionStorage.clear()
})

async function search(query: string): Promise<void> {
  const user = userEvent.setup()

  render(withQueryClient(<AddBookWizard />))

  const input = await screen.findByLabelText('Назва або ISBN')
  await user.type(input, query)
  await user.click(screen.getByRole('button', { name: 'Шукати' }))
}

/** Renders `/catalog/new?mode=scan` and drives the mocked scanner to a valid decode. */
async function searchViaScan(): Promise<void> {
  searchParams = new URLSearchParams('mode=scan')
  const user = userEvent.setup()

  render(withQueryClient(<AddBookWizard />))

  const scanButton = await screen.findByRole('button', { name: 'Simulate scan' })
  await user.click(scanButton)
}

describe('крок 1 — пошук кандидатів', () => {
  it('показує знайдені твори з їхніми виданнями', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [candidate()] }),
    })

    await search('Кобзар')

    expect(await screen.findByText('Кобзар')).toBeInTheDocument()
    expect(screen.getByText('Тарас Шевченко')).toBeInTheDocument()
  })
})

describe('гілка «наявне Edition»', () => {
  it('створює лише Copy, минаючи Work/Translation/Edition', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [
          candidate({ editions: [edition({ id: 'edition-match', isbn13: CANDIDATE_ISBN })] }),
        ],
      }),
      '/me/library': ({ body }) => {
        expect(body).toMatchObject({ editionId: 'edition-match' })
        return undefined
      },
    })

    await search(CANDIDATE_ISBN)

    expect(await screen.findByText('точний збіг за ISBN')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Це моє видання' }))

    expect(await screen.findByText('Ваш примірник')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledWith(
        '/me/library',
        expect.objectContaining({ method: 'POST' }),
      )
    })

    expect(await screen.findByText(/тепер у вашій бібліотеці/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ще один такий примірник' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Додати наступну книгу' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Сканувати наступну' })).toBeInTheDocument()

    // Жодного кроку створення Work/Translation/Edition не було.
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works', expect.anything())
  })
})

describe('швидке послідовне додавання', () => {
  it('adds another Copy for the same Edition and keeps only safe session defaults', async () => {
    const copyBodies: unknown[] = []
    let searchCount = 0
    routeApiRequest({
      '/catalog/search/candidates': () => {
        searchCount += 1

        return {
          candidates: [
            searchCount === 1
              ? candidate({ editions: [edition({ id: 'edition-repeat' })] })
              : candidate({
                  work: work({ id: 'work-next', title: 'Місто' }),
                  editions: [edition({ id: 'edition-next', workId: 'work-next' })],
                }),
          ],
        }
      },
      '/me/library': ({ body }) => {
        copyBodies.push(body)
        return undefined
      },
    })

    await search('Кобзар')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
    await user.selectOptions(screen.getByLabelText('Стан примірника'), 'WORN')
    await user.selectOptions(screen.getByLabelText('Кому показувати'), 'PRIVATE')
    await user.type(screen.getByLabelText('Нотатка'), 'Лише для першого')
    await user.type(screen.getByLabelText('Коли зʼявилася'), '2026-09-01')
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await user.click(await screen.findByRole('button', { name: 'Ще один такий примірник' }))

    expect(screen.getByLabelText('Стан примірника')).toHaveValue('WORN')
    expect(screen.getByLabelText('Кому показувати')).toHaveValue('PRIVATE')
    expect(screen.getByLabelText('Нотатка')).toHaveValue('')
    expect(screen.getByLabelText('Коли зʼявилася')).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText(/тепер у вашій бібліотеці/)

    expect(copyBodies).toEqual([
      {
        editionId: 'edition-repeat',
        condition: 'WORN',
        visibility: 'PRIVATE',
        note: 'Лише для першого',
        acquiredAt: '2026-09-01',
        entryMethod: 'MANUAL',
      },
      {
        editionId: 'edition-repeat',
        condition: 'WORN',
        visibility: 'PRIVATE',
        note: null,
        acquiredAt: null,
        entryMethod: 'MANUAL',
      },
    ])

    await user.click(screen.getByRole('button', { name: 'Додати наступну книгу' }))
    expect(push).toHaveBeenCalledWith('/catalog/new')
    const nextSearch = await screen.findByLabelText('Назва або ISBN')
    expect(nextSearch).toHaveValue('')

    await user.type(nextSearch, 'Місто')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))

    expect(screen.getByLabelText('Стан примірника')).toHaveValue('WORN')
    expect(screen.getByLabelText('Кому показувати')).toHaveValue('PRIVATE')
    expect(screen.getByLabelText('Нотатка')).toHaveValue('')
    expect(screen.getByLabelText('Коли зʼявилася')).toHaveValue('')

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText(/«Місто» тепер у вашій бібліотеці/)

    expect(copyBodies[2]).toEqual({
      editionId: 'edition-next',
      condition: 'WORN',
      visibility: 'PRIVATE',
      note: null,
      acquiredAt: null,
      entryMethod: 'MANUAL',
    })
  })

  it('opens the scanner entry URL and starts with a clean search', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [edition({ id: 'edition-scan-next' })] })],
      }),
      '/me/library': () => undefined,
    })

    await search('Кобзар')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await user.click(await screen.findByRole('button', { name: 'Сканувати наступну' }))

    expect(push).toHaveBeenCalledWith('/catalog/new?mode=scan')
    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('')
  })

  it('remounts clean search state when URL history changes', async () => {
    searchParams = new URLSearchParams('q=Кобзар')
    // One client across all three renders: a fresh provider per rerender would
    // remount the subtree, and this test is about the URL driving the reset.
    const client = createTestQueryClient()
    const { rerender } = render(withQueryClient(<AddBookWizard />, client))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Кобзар')

    searchParams = new URLSearchParams()
    rerender(withQueryClient(<AddBookWizard />, client))
    expect(screen.getByLabelText('Назва або ISBN')).toHaveValue('')

    searchParams = new URLSearchParams('q=Кобзар')
    rerender(withQueryClient(<AddBookWizard />, client))
    expect(screen.getByLabelText('Назва або ISBN')).toHaveValue('Кобзар')
  })
})

describe('гілка «наявне Work»', () => {
  it('веде одразу до нового Edition (+ опційний Translation), минаючи Work', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [candidate({ editions: [] })] }),
      '/works/work-1/editions': ({ body }) => {
        expect(body).toMatchObject({ translationId: null })
        return { edition: edition({ id: 'edition-new' }) }
      },
      '/me/library': ({ body }) => {
        expect(body).toMatchObject({ editionId: 'edition-new' })
        return undefined
      },
    })

    await search('Кобзар')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'У мене інше видання цього твору' }))

    expect(await screen.findByText('Переклад')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Пропустити — це оригінал' }))

    expect(await screen.findByText('Видання')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

    expect(await screen.findByText('Ваш примірник')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/тепер у вашій бібліотеці/)).toBeInTheDocument()

    // Регресія: гілка «наявний Work» без lookup (текстовий пошук, не ISBN)
    // працює так само, як і до додавання lookup-передачі нижче.
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works', expect.anything())
  })

  it('lookup-чернетка доходить до нового Translation/Edition, а не губиться на виборі наявного Work', async () => {
    let translationPayload: unknown
    let editionPayload: unknown

    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [], translations: [] })],
      }),
      '/catalog/lookup': () => ({
        result: {
          title: 'Ігнорується — Work наявний',
          authors: ['Ігнорується'],
          publishedYear: 2001,
          language: 'de',
          publisher: 'Видавництво з лукапу',
          coverUrl: 'https://example.com/cover.jpg',
        },
      }),
      '/works/work-1/translations': ({ body }) => {
        translationPayload = body
        return { translation: translation({ id: 'translation-new', workId: 'work-1' }) }
      },
      '/works/work-1/editions': ({ body }) => {
        editionPayload = body
        return { edition: edition({ id: 'edition-new', workId: 'work-1' }) }
      },
      '/me/library': () => undefined,
    })

    await search(CANDIDATE_ISBN)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'У мене інше видання цього твору' }))

    expect(await screen.findByText('Переклад')).toBeInTheDocument()
    // §6.3 п.12: наявний Work не редагується повторно — жодного запиту на
    // /works, і назва/автори з lookup ніде не показуються на цьому кроці.
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works', expect.anything())
    expect(screen.queryByText('Ігнорується — Work наявний')).not.toBeInTheDocument()

    // Мова видання з lookup — лише в полі мови ПЕРЕКЛАДУ.
    expect(screen.getByLabelText('Мова перекладу')).toHaveValue('de')
    expect(screen.getByLabelText('З якої мови перекладено')).toHaveValue('')

    await user.type(screen.getByLabelText('З якої мови перекладено'), 'en')
    await user.type(screen.getByLabelText('Перекладач'), 'Новий Перекладач')
    await user.click(screen.getByRole('button', { name: 'Далі: видання' }))

    expect(await screen.findByText('Видання')).toBeInTheDocument()
    expect(screen.getByLabelText('Рік видання')).toHaveValue(2001)
    expect(screen.getByLabelText('Видавництво')).toHaveValue('Видавництво з лукапу')
    expect(screen.getByLabelText('Обкладинка (посилання)')).toHaveValue(
      'https://example.com/cover.jpg',
    )
    expect(screen.getByLabelText('ISBN-13')).toHaveValue(CANDIDATE_ISBN)

    // Ручна правка після lookup зберігається — наступний рендер її не затирає.
    await user.clear(screen.getByLabelText('Видавництво'))
    await user.type(screen.getByLabelText('Видавництво'), 'Виправлене видавництво')

    await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

    await waitFor(() => {
      expect(translationPayload).toMatchObject({
        translator: 'Новий Перекладач',
        lang: 'de',
        sourceLang: 'en',
      })
    })
    expect(editionPayload).toMatchObject({
      year: 2001,
      publisher: 'Виправлене видавництво',
      coverUrl: 'https://example.com/cover.jpg',
      isbn13: CANDIDATE_ISBN,
      translationId: 'translation-new',
    })
  })

  it('наявний Translation можна перевикористати — новий Translation не створюється, lookup-мова його не чіпає', async () => {
    let editionPayload: unknown

    const existingTranslation = translation({
      id: 'translation-existing',
      workId: 'work-1',
      translator: 'Старий Перекладач',
      lang: 'fr',
    })

    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [], translations: [existingTranslation] })],
      }),
      '/catalog/lookup': () => ({
        // Мова lookup відрізняється від мови наявного перекладу — якби вона
        // якось потрапляла на наявний запис, це було б видно в assert нижче.
        result: { title: 'З лукапу', publishedYear: 1999, language: 'de' },
      }),
      '/works/work-1/editions': ({ body }) => {
        editionPayload = body
        return { edition: edition({ id: 'edition-new', workId: 'work-1' }) }
      },
      '/me/library': () => undefined,
    })

    await search(CANDIDATE_ISBN)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'У мене інше видання цього твору' }))

    expect(await screen.findByText('Переклад')).toBeInTheDocument()
    expect(
      screen.getByText('У цього твору вже є переклади — можливо, ваш серед них.'),
    ).toBeInTheDocument()
    expect(screen.getByText(/Старий Перекладач/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Використати цей переклад' }))

    expect(await screen.findByText('Видання')).toBeInTheDocument()
    // Дані видання все одно підставляються з lookup — лише мова переклад не
    // чіпається (наявний Translation не редагується цим флоу).
    expect(screen.getByLabelText('Рік видання')).toHaveValue(1999)

    await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

    await waitFor(() => {
      expect(editionPayload).toMatchObject({ translationId: 'translation-existing' })
    })

    // Жодного POST на створення нового Translation — саме наявний перевикористаний.
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works/work-1/translations', expect.anything())
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works', expect.anything())
  })
})

describe('гілка «наявне Edition» — lookup не впливає', () => {
  it('lookup успішний, але гілка «наявне Edition» все одно створює лише Copy', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [
          candidate({ editions: [edition({ id: 'edition-match', isbn13: CANDIDATE_ISBN })] }),
        ],
      }),
      '/catalog/lookup': () => ({
        result: { title: 'Не повинно нікуди потрапити', publishedYear: 2001, language: 'de' },
      }),
      '/me/library': ({ body }) => {
        expect(body).toMatchObject({ editionId: 'edition-match' })
        return undefined
      },
    })

    await search(CANDIDATE_ISBN)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))

    expect(await screen.findByText('Ваш примірник')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/тепер у вашій бібліотеці/)).toBeInTheDocument()

    expect(mockApiRequest).not.toHaveBeenCalledWith('/works', expect.anything())
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works/work-1/translations', expect.anything())
    expect(mockApiRequest).not.toHaveBeenCalledWith('/works/work-1/editions', expect.anything())
  })
})

describe('гілка «немає збігів»', () => {
  it('веде повним ланцюгом Work → Translation → Edition → Copy', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      // Зовнішні джерела відповіли й нічого не знайшли. Це не те саме, що
      // «не відповіли»: лише в першому випадку можна сказати «нічого схожого».
      '/catalog/search/external': () => ({
        results: [],
        sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
      }),
      '/works': ({ body }) => {
        expect(body).toMatchObject({ title: 'Новий твір' })
        return {
          work: work({ id: 'work-new', title: 'Новий твір' }),
          authors: [],
          translations: [],
          editions: [],
        }
      },
      '/works/work-new/editions': () => ({
        edition: edition({ id: 'edition-new', workId: 'work-new' }),
      }),
      '/me/library': () => undefined,
    })

    await search('Новий твір')

    expect(
      await screen.findByText('Нічого схожого не знайшлося. Заведемо новий твір.'),
    ).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Створити новий твір' }))

    expect(await screen.findByText('Твір')).toBeInTheDocument()
    expect(screen.getByLabelText('Назва твору')).toHaveValue('Новий твір')

    await user.type(screen.getByLabelText('Імʼя'), 'Тестовий Автор')
    await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

    expect(await screen.findByText('Переклад')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Пропустити — це оригінал' }))

    expect(await screen.findByText('Видання')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

    expect(await screen.findByText('Ваш примірник')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    expect(await screen.findByText(/тепер у вашій бібліотеці/)).toBeInTheDocument()
  })

  it('показує точну зовнішню знахідку перед заповненою формою', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/catalog/lookup': () => ({
        result: {
          title: 'Influence, New and Expanded',
          authors: ['Robert B Cialdini PhD'],
          publisher: 'Harper Business',
          publishedYear: 2021,
          source: 'GOOGLE_BOOKS',
        },
      }),
    })

    await search(CANDIDATE_ISBN)

    expect(
      await screen.findByText('У каталозі BookSwap цього видання ще немає.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Influence, New and Expanded')).toBeInTheDocument()
    expect(screen.getByText('Robert B Cialdini PhD')).toBeInTheDocument()
    expect(screen.getByText('Harper Business · 2021')).toBeInTheDocument()
    expect(screen.getByText('Знайдено за ISBN у Google Books')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Додати цю книжку' }))

    expect(await screen.findByText('Твір')).toBeInTheDocument()
    expect(screen.getByLabelText('Назва твору')).toHaveValue('Influence, New and Expanded')
  })

  it('підставляє дані з lookup у форму Work як редаговану чернетку', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/catalog/lookup': () => ({
        result: { title: 'З лукапу', authors: ['Автор Один', 'Автор Два'], publishedYear: 2001 },
      }),
    })

    await search(CANDIDATE_ISBN)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Додати цю книжку' }))

    expect(await screen.findByText('Твір')).toBeInTheDocument()
    expect(screen.getByLabelText('Назва твору')).toHaveValue('З лукапу')

    // §6.3 п.2–3: рік ISBN-видання — це Edition.year, не Work.firstPubYear.
    // Провайдер не дає окремого work-level поля, тож рік першої публікації
    // твору лишається порожнім і редагованим руками.
    expect(screen.getByLabelText('Рік першого видання')).toHaveValue(null)

    const authorNames = screen.getAllByLabelText('Імʼя')
    expect(authorNames.map((input) => (input as HTMLInputElement).value)).toEqual([
      'Автор Один',
      'Автор Два',
    ])

    // Підставлене — все ще звичайне контрольоване поле: правиться руками до збереження.
    await user.clear(screen.getByLabelText('Назва твору'))
    await user.type(screen.getByLabelText('Назва твору'), 'Виправлена назва')
    expect(screen.getByLabelText('Назва твору')).toHaveValue('Виправлена назва')
  })

  it('рік видання, видавництво, обкладинка й мова з lookup доходять до Translation/Edition — не до Work', async () => {
    let editionPayload: unknown

    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/catalog/lookup': () => ({
        result: {
          title: 'З лукапу',
          authors: ['Автор Один'],
          publishedYear: 2001,
          language: 'de',
          publisher: 'Видавництво з лукапу',
          coverUrl: 'https://example.com/cover.jpg',
        },
      }),
      '/works': () => ({
        work: work({ id: 'work-new', title: 'З лукапу' }),
        authors: [],
        translations: [],
        editions: [],
      }),
      '/works/work-new/translations': () => ({
        translation: translation({ id: 'translation-new', workId: 'work-new' }),
      }),
      '/works/work-new/editions': ({ body }) => {
        editionPayload = body
        return { edition: edition({ id: 'edition-new', workId: 'work-new' }) }
      },
      '/me/library': () => undefined,
    })

    await search(CANDIDATE_ISBN)

    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Додати цю книжку' }))

    expect(await screen.findByText('Твір')).toBeInTheDocument()
    // Work-крок не отримує ні року видання, ні мови видання — жодного поля
    // "мова" на цьому кроці взагалі немає під підказкою lookup.
    expect(screen.getByLabelText('Рік першого видання')).toHaveValue(null)

    await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))

    expect(await screen.findByText('Переклад')).toBeInTheDocument()
    // §6.3 п.7: мова ISBN-видання автозаповнює саме мову перекладу…
    expect(screen.getByLabelText('Мова перекладу')).toHaveValue('de')
    // …і ніколи мову джерела: поле лишається порожнім, доки його явно не заповнять.
    expect(screen.getByLabelText('З якої мови перекладено')).toHaveValue('')
    await user.type(screen.getByLabelText('З якої мови перекладено'), 'en')
    await user.type(screen.getByLabelText('Перекладач'), 'Тестовий Перекладач')
    await user.click(screen.getByRole('button', { name: 'Далі: видання' }))

    expect(await screen.findByText('Видання')).toBeInTheDocument()
    expect(screen.getByLabelText('Рік видання')).toHaveValue(2001)
    expect(screen.getByLabelText('Видавництво')).toHaveValue('Видавництво з лукапу')
    expect(screen.getByLabelText('Обкладинка (посилання)')).toHaveValue(
      'https://example.com/cover.jpg',
    )

    // Редагування після lookup не відкочується наступним рендером.
    await user.clear(screen.getByLabelText('Видавництво'))
    await user.type(screen.getByLabelText('Видавництво'), 'Виправлене видавництво')

    await user.click(screen.getByRole('button', { name: 'Далі: мій примірник' }))

    await waitFor(() => {
      expect(editionPayload).toMatchObject({
        year: 2001,
        publisher: 'Виправлене видавництво',
        coverUrl: 'https://example.com/cover.jpg',
      })
    })
  })
})

describe('помилки провайдера й rate limiting', () => {
  it('429 на пошуку кандидатів — зрозуміле повідомлення, а не сирий текст ThrottlerException', async () => {
    const { ApiRequestError } = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

    routeApiRequest({
      '/catalog/search/candidates': () => {
        throw new ApiRequestError(429, {
          code: 'TOO_MANY_REQUESTS',
          message: 'ThrottlerException: Too Many Requests',
        })
      },
    })

    await search('Кобзар')

    expect(
      await screen.findByText('Забагато запитів поспіль. Зачекайте хвилину і спробуйте ще раз.'),
    ).toBeInTheDocument()
  })

  it('504 на lookup — некритична підказка, кандидати все одно показуються', async () => {
    const { ApiRequestError } = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/catalog/lookup': () => {
        throw new ApiRequestError(504, {
          code: 'CATALOG_LOOKUP_TIMEOUT',
          message: 'Зовнішній провайдер не відповів вчасно',
        })
      },
    })

    await search(CANDIDATE_ISBN)

    expect(
      await screen.findByText(
        'Зовнішній сервіс автозаповнення не відповів вчасно. Можна заповнити форму вручну.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Нічого схожого не знайшлося. Заведемо новий твір.'),
    ).toBeInTheDocument()
  })

  it('502 помилка провайдера на lookup — та сама некритична підказка', async () => {
    const { ApiRequestError } = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/catalog/lookup': () => {
        throw new ApiRequestError(502, {
          code: 'CATALOG_LOOKUP_PROVIDER_ERROR',
          message: 'Зовнішній провайдер повернув помилку: 500',
        })
      },
    })

    await search(CANDIDATE_ISBN)

    expect(
      await screen.findByText(
        'Зовнішній сервіс автозаповнення зараз недоступний. Можна заповнити форму вручну.',
      ),
    ).toBeInTheDocument()
  })
})

describe('camera scan — entryMethod BARCODE', () => {
  it('a scanned ISBN on the existing-Edition branch creates a Copy with entryMethod BARCODE', async () => {
    let copyBody: unknown
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [
          candidate({ editions: [edition({ id: 'edition-match', isbn13: CANDIDATE_ISBN })] }),
        ],
      }),
      '/me/library': ({ body }) => {
        copyBody = body
        return undefined
      },
    })

    await searchViaScan()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => expect(copyBody).toMatchObject({ entryMethod: 'BARCODE' }))
  })

  it('a scanned ISBN on the existing-Work → Translation → Edition branch keeps entryMethod BARCODE', async () => {
    let copyBody: unknown
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [candidate({ editions: [] })] }),
      '/works/work-1/editions': () => ({ edition: edition({ id: 'edition-new' }) }),
      '/me/library': ({ body }) => {
        copyBody = body
        return undefined
      },
    })

    await searchViaScan()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'У мене інше видання цього твору' }))
    await user.click(await screen.findByRole('button', { name: 'Пропустити — це оригінал' }))
    await user.click(await screen.findByRole('button', { name: 'Далі: мій примірник' }))
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => expect(copyBody).toMatchObject({ entryMethod: 'BARCODE' }))
  })

  it('a scanned ISBN on the new-Work → Translation → Edition branch keeps entryMethod BARCODE', async () => {
    let copyBody: unknown
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
      '/works': () => ({
        work: work({ id: 'work-new', title: 'Новий твір' }),
        authors: [],
        translations: [],
        editions: [],
      }),
      '/works/work-new/editions': () => ({
        edition: edition({ id: 'edition-new', workId: 'work-new' }),
      }),
      '/me/library': ({ body }) => {
        copyBody = body
        return undefined
      },
    })

    await searchViaScan()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Створити новий твір' }))
    await user.type(screen.getByLabelText('Імʼя'), 'Тестовий Автор')
    await user.click(screen.getByRole('button', { name: 'Далі: переклад' }))
    await user.click(await screen.findByRole('button', { name: 'Пропустити — це оригінал' }))
    await user.click(await screen.findByRole('button', { name: 'Далі: мій примірник' }))
    await user.click(await screen.findByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => expect(copyBody).toMatchObject({ entryMethod: 'BARCODE' }))
  })

  it('repeating the same Edition after a BARCODE-originated copy still POSTs MANUAL', async () => {
    const copyBodies: unknown[] = []
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [edition({ id: 'edition-repeat' })] })],
      }),
      '/me/library': ({ body }) => {
        copyBodies.push(body)
        return undefined
      },
    })

    await searchViaScan()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await user.click(await screen.findByRole('button', { name: 'Ще один такий примірник' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))
    await screen.findByText(/тепер у вашій бібліотеці/)

    expect(copyBodies).toHaveLength(2)
    expect(copyBodies[0]).toMatchObject({ entryMethod: 'BARCODE' })
    expect(copyBodies[1]).toMatchObject({ entryMethod: 'MANUAL' })
  })

  it('manual fallback in scan mode (e.g. after a camera error) still POSTs MANUAL', async () => {
    let copyBody: unknown
    searchParams = new URLSearchParams('mode=scan')
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [edition({ id: 'edition-manual' })] })],
      }),
      '/me/library': ({ body }) => {
        copyBody = body
        return undefined
      },
    })

    const user = userEvent.setup()
    render(withQueryClient(<AddBookWizard />))

    // The user never uses the scanner (e.g. it errored) — falls back to the
    // manual field, which is always visible alongside it.
    const input = await screen.findByLabelText('Назва або ISBN')
    await user.type(input, 'Кобзар')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    await user.click(await screen.findByRole('button', { name: 'Це моє видання' }))
    await user.click(screen.getByRole('button', { name: 'Додати до бібліотеки' }))

    await waitFor(() => expect(copyBody).toMatchObject({ entryMethod: 'MANUAL' }))
  })
})

// Спокійний smoke-тест на найпростіший рендер, щоб `within` не лишався невикористаним
// експортом бібліотеки — придатний для точкового пошуку всередині картки кандидата.
describe('картка кандидата', () => {
  it('показує видання разом із твором', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({
        candidates: [candidate({ editions: [edition({ publisher: 'КСД' })] })],
      }),
    })

    await search('Кобзар')

    const item = (await screen.findByText('Кобзар')).closest('li')
    expect(item).not.toBeNull()
    expect(within(item as HTMLElement).getByText(/КСД/)).toBeInTheDocument()
  })
})

describe('прихід із каталогу з уже обраним зовнішнім записом', () => {
  const chosen = {
    id: 'GOOGLE_BOOKS:v1',
    kind: 'EDITION' as const,
    sources: ['GOOGLE_BOOKS' as const],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    publishedYear: 2021,
    publisher: 'Смолоскип',
  }

  /** Кладе вибір і відкриває майстер САМЕ за тим переходом, який його породив. */
  function arrive(): void {
    const token = stashExternalSelection(chosen, 'Тигролови')

    expect(token).toBeDefined()
    searchParams = new URLSearchParams(`q=Тигролови&external=${String(token)}`)
    render(withQueryClient(<AddBookWizard />))
  }

  it('одразу перевіряє дублікати й веде у форму — без повторного пошуку', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    arrive()

    // Людина нічого не вводила й не натискала: майстер продовжив саме з тим
    // записом, який вона обрала в каталозі.
    expect(await screen.findByText('Твір')).toBeInTheDocument()
    expect(screen.getByLabelText('Назва твору')).toHaveValue('Тигролови')
  })

  it('знайдені дублікати показуються для обраного запису', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [candidate()] }),
    })

    arrive()

    // Спершу чекаємо на РЕЗУЛЬТАТ перевірки: стан «перевіряю» теж пише
    // «Обрано: …», тож сам цей рядок ще нічого не доводить.
    expect(
      await screen.findByText(
        'Схожі твори вже є у BookSwap. Якщо це одна з цих книжок — оберіть її.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Обрано: Тигролови')).toBeInTheDocument()
  })

  it('до підтвердження нічого не створюється', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    arrive()

    await screen.findByText('Твір')

    // Перевірка дублікатів — це читання. Жодного запису до підтвердження форми.
    const written = mockApiRequest.mock.calls.filter(
      ([, options]: [string, { body?: unknown } | undefined]) => options?.body !== undefined,
    )
    expect(written).toEqual([])
  })

  it('перевірка дублікатів доходить до кінця і під подвійним монтуванням', async () => {
    // Регресія: StrictMode монтує, розмонтовує й монтує той самий компонент.
    // Поки розмонтування «відв'язувало» перевірку лічильником, відповідь на
    // неї відкидалася, повторно ніхто не питав — і крок назавжди лишався на
    // «Перевіряю, чи така книжка вже є у BookSwap…».
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    const token = stashExternalSelection(chosen, 'Тигролови')

    searchParams = new URLSearchParams(`q=Тигролови&external=${String(token)}`)
    render(<StrictMode>{withQueryClient(<AddBookWizard />)}</StrictMode>)

    expect(await screen.findByText('Твір')).toBeInTheDocument()
    expect(screen.queryByText(/Перевіряю, чи така книжка вже є/)).not.toBeInTheDocument()
  })

  it('без позначки в адресі збережений запис не підхоплюється', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    stashExternalSelection(chosen, 'Тигролови')
    searchParams = new URLSearchParams('q=Тигролови')
    render(withQueryClient(<AddBookWizard />))

    // Адреса вирішує, а не сховище: інакше запис із давнього вибору сам собою
    // перехоплював би звичайний вхід у майстер.
    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Тигролови')
    expect(screen.queryByText('Обрано: Тигролови')).not.toBeInTheDocument()
  })

  // --- вибір прив'язаний до ОДНОГО переходу -------------------------------

  it('чужий токен не підхоплює збереженого вибору', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    // Обрано книжку А…
    stashExternalSelection(chosen, 'Тигролови')
    // …а відкривають перехід, якого ніхто не створював.
    searchParams = new URLSearchParams('q=Тигролови&external=not-the-token-that-was-minted')
    render(withQueryClient(<AddBookWizard />))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Тигролови')
    expect(screen.queryByText('Обрано: Тигролови')).not.toBeInTheDocument()
  })

  it('той самий токен під іншим запитом не підхоплює вибору', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    const token = stashExternalSelection(chosen, 'Тигролови')

    // Той самий перехід, але адреса каже про інший пошук. Порівнювати назви
    // тут не можна: два тиражі однієї книжки звуться однаково.
    searchParams = new URLSearchParams(`q=Кобзар&external=${String(token)}`)
    render(withQueryClient(<AddBookWizard />))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Кобзар')
    expect(screen.queryByText('Обрано: Тигролови')).not.toBeInTheDocument()
  })

  it('вибір книжки А не відкривається переходом, створеним для Б', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    // Перехід для Б створено ПЕРШИМ, далі людина повернулася й обрала А.
    const tokenForB = stashExternalSelection(
      { ...chosen, id: 'GOOGLE_BOOKS:v2', title: 'Сад Гетсиманський' },
      'Сад',
    )
    stashExternalSelection(chosen, 'Тигролови')

    searchParams = new URLSearchParams(`q=Сад&external=${String(tokenForB)}`)
    render(withQueryClient(<AddBookWizard />))

    // Саме той дефект: без прив'язки тут відкрилася б форма для А.
    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Сад')
    expect(screen.queryByText('Обрано: Тигролови')).not.toBeInTheDocument()
    expect(screen.queryByText('Обрано: Сад Гетсиманський')).not.toBeInTheDocument()
  })

  it('порожнє сховище дає звичайний пошук', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    searchParams = new URLSearchParams('q=Тигролови&external=some-token')
    render(withQueryClient(<AddBookWizard />))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Тигролови')
    expect(screen.queryByText(/Обрано:/)).not.toBeInTheDocument()
  })

  it('пошкоджене сховище дає звичайний пошук, а не аварію', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    const token = stashExternalSelection(chosen, 'Тигролови')

    // Той самий ключ, але вміст уже не той, що ми писали.
    for (const key of Object.keys(sessionStorage)) sessionStorage.setItem(key, '{ not json')

    searchParams = new URLSearchParams(`q=Тигролови&external=${String(token)}`)
    render(withQueryClient(<AddBookWizard />))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Тигролови')
    expect(screen.queryByText(/Обрано:/)).not.toBeInTheDocument()
  })

  it('недоступне сховище дає звичайний пошук', async () => {
    routeApiRequest({
      '/catalog/search/candidates': () => ({ candidates: [] }),
    })

    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage disabled')
    })

    searchParams = new URLSearchParams('q=Тигролови&external=some-token')
    render(withQueryClient(<AddBookWizard />))

    expect(await screen.findByLabelText('Назва або ISBN')).toHaveValue('Тигролови')
    expect(screen.queryByText(/Обрано:/)).not.toBeInTheDocument()

    getItem.mockRestore()
  })
})
