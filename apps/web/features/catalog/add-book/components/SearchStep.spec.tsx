/** @jest-environment jsdom */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { BookLookupResult, WorkDetailResponse } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { SearchStep } from './SearchStep'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

/**
 * `BarcodeScannerPanel` has its own dedicated spec covering camera
 * lifecycle/errors — here it's replaced by a deterministic stand-in so
 * `SearchStep` tests exercise only the entry-method threading contract.
 * Mocked by the named loader module (not `./BarcodeScannerPanel` directly):
 * `SearchStep` reaches it via `next/dynamic`, whose loader argument contains
 * a real dynamic `import()` that this project's ts-jest config can't
 * execute — mocking the whole loader module sidesteps that entirely.
 */
jest.mock('../lib/load-barcode-scanner-panel', () => ({
  loadBarcodeScannerPanel: () =>
    Promise.resolve(({ onValidIsbn }: { onValidIsbn: (isbn: string) => void }) => (
      <button type="button" onClick={() => onValidIsbn('9783161484100')}>
        Simulate scan
      </button>
    )),
}))

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const ISBN = '9783161484100'
const lookup: BookLookupResult = { title: 'Lookup title', language: 'en' }
const candidate: WorkDetailResponse = {
  work: {
    id: 'work-1',
    title: 'Кобзар',
    origLang: 'uk',
    firstPubYear: 1840,
    description: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [
    { id: 'author-1', name: 'Тарас Шевченко', nameLatin: null, role: 'AUTHOR', position: 0 },
  ],
  translations: [],
  editions: [
    {
      id: 'edition-1',
      workId: 'work-1',
      translationId: null,
      publisher: 'Наука',
      year: 2019,
      isbn13: ISBN,
      pageCount: 320,
      coverUrl: null,
      format: 'HARDCOVER',
      lang: 'uk',
      translator: null,
      revision: 1,
    },
  ],
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value)
    },
  }
}

/**
 * Порожня, але СХЕМНО ПРАВИЛЬНА відповідь зовнішнього пошуку.
 *
 * Потрібна майже скрізь: відколи пошук за назвою опитує ще й зовнішні
 * каталоги, кожен не-ISBN запит робить другий виклик. Тести, які його не
 * стосуються, мусять на нього все одно відповісти — інакше секція зовнішніх
 * результатів показала б збій, якого сценарій не перевіряє.
 */
const NO_EXTERNAL_RESULTS = { results: [], sources: [] }

/** Маршрутизація моку за шляхом — надійніша за порядок викликів, бо запити паралельні. */
function routeApi(handlers: Record<string, () => unknown>) {
  mockApiRequest.mockImplementation((path: string) => {
    for (const [prefix, handler] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) return handler()
    }

    return Promise.reject(new Error(`Unexpected path: ${path}`))
  })
}

function renderSearch(initialQuery = '') {
  const callbacks = {
    onFoundEdition: jest.fn(),
    onFoundWork: jest.fn(),
    onCreateNew: jest.fn(),
  }

  render(<SearchStep initialQuery={initialQuery} {...callbacks} />)

  return callbacks
}

beforeEach(() => {
  mockApiRequest.mockReset()
})

it('validates the query with the shared Zod contract before searching', async () => {
  const user = userEvent.setup()
  renderSearch()

  await user.type(screen.getByLabelText('Назва або ISBN'), 'x')
  await user.click(screen.getByRole('button', { name: 'Шукати' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Мінімум два символи')
  expect(mockApiRequest).not.toHaveBeenCalled()
})

it('starts candidate and ISBN lookup requests in parallel and preserves the selection context', async () => {
  const candidatesRequest = deferred<{ candidates: WorkDetailResponse[] }>()
  const lookupRequest = deferred<{ result: BookLookupResult }>()

  mockApiRequest.mockImplementation((path: string) => {
    return path.startsWith('/catalog/search/candidates')
      ? candidatesRequest.promise
      : lookupRequest.promise
  })

  const callbacks = renderSearch(ISBN)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Шукати' }))

  await waitFor(() => expect(mockApiRequest).toHaveBeenCalledTimes(2))
  lookupRequest.resolve({ result: lookup })
  candidatesRequest.resolve({ candidates: [candidate] })

  expect(await screen.findByText('точний збіг за ISBN')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Це моє видання' }))
  expect(callbacks.onFoundEdition).toHaveBeenCalledWith({
    workId: 'work-1',
    title: 'Кобзар',
    editionId: 'edition-1',
    entryMethod: 'MANUAL',
  })

  await user.click(screen.getByRole('button', { name: 'У мене інше видання цього твору' }))
  expect(callbacks.onFoundWork).toHaveBeenCalledWith({
    workId: 'work-1',
    title: 'Кобзар',
    isbn: ISBN,
    lookup,
    existingTranslations: [],
    entryMethod: 'MANUAL',
  })
})

it('keeps the validated query for a retry and then creates a new work from its result', async () => {
  let candidateCalls = 0

  routeApi({
    '/catalog/search/external': () => Promise.resolve(NO_EXTERNAL_RESULTS),
    '/catalog/search/candidates': () => {
      candidateCalls += 1

      return candidateCalls === 1
        ? Promise.reject(
            new ApiRequestError(429, {
              code: 'TOO_MANY_REQUESTS',
              message: 'ThrottlerException: Too Many Requests',
            }),
          )
        : Promise.resolve({ candidates: [] })
    },
  })

  const callbacks = renderSearch()
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Назва або ISBN'), '  Дюна  ')
  await user.click(screen.getByRole('button', { name: 'Шукати' }))

  expect(
    await screen.findByText('Забагато запитів поспіль. Зачекайте хвилину і спробуйте ще раз.'),
  ).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Шукати' }))
  await user.click(await screen.findByRole('button', { name: 'Створити новий твір' }))

  // Рівно дві спроби локального пошуку: перша впала, друга — повтор того
  // самого валідованого запиту. Зовнішні виклики рахуються окремо й на це
  // число не впливають.
  expect(candidateCalls).toBe(2)
  expect(callbacks.onCreateNew).toHaveBeenCalledWith({
    initialTitle: 'Дюна',
    entryMethod: 'MANUAL',
  })
})

/**
 * Регресія: сканер висів за `?mode=scan`, тому вхід у нього вимагав навігації —
 * перший раз узагалі лише ручною правкою адреси. Тепер панель на місці завжди,
 * а її кнопка старту вмикає камеру тим самим натисканням, без переходу.
 */
describe('вхід у сканування', () => {
  it('offers the scanner on the default page, with no mode parameter and no navigation', async () => {
    renderSearch()

    expect(await screen.findByRole('button', { name: 'Simulate scan' })).toBeInTheDocument()
    // Жодного посилання-переходу: вхід — це кнопка самої панелі.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('keeps the manual ISBN/title search available alongside it', async () => {
    renderSearch()

    expect(screen.getByLabelText('Назва або ISBN')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Шукати' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Simulate scan' })).toBeInTheDocument()
  })
})

describe('скановане ISBN', () => {
  it('routes a scanned ISBN through the same search orchestration and tags the result BARCODE', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      return path.startsWith('/catalog/search/candidates')
        ? Promise.resolve({ candidates: [candidate] })
        : Promise.resolve({ result: lookup })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Simulate scan' }))

    expect(await screen.findByText('точний збіг за ISBN')).toBeInTheDocument()
    expect(mockApiRequest).toHaveBeenCalledWith(
      expect.stringContaining('/catalog/search/candidates'),
      expect.anything(),
    )

    await user.click(screen.getByRole('button', { name: 'Це моє видання' }))
    expect(callbacks.onFoundEdition).toHaveBeenCalledWith({
      workId: 'work-1',
      title: 'Кобзар',
      editionId: 'edition-1',
      entryMethod: 'BARCODE',
    })
  })

  it('a manual submit after a successful scan resets the tag to MANUAL and stops the scanner', async () => {
    routeApi({
      '/catalog/search/external': () => Promise.resolve(NO_EXTERNAL_RESULTS),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
      '/catalog/lookup': () => Promise.resolve({ result: lookup }),
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()

    const scanButton = screen.getByRole('button', { name: 'Simulate scan' })
    await user.click(scanButton)
    await screen.findByRole('button', { name: 'Це моє видання' })

    await user.type(screen.getByLabelText('Назва або ISBN'), 'Кобзар')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await screen.findByRole('button', { name: 'Це моє видання' })

    await user.click(screen.getByRole('button', { name: 'Це моє видання' }))
    expect(callbacks.onFoundEdition).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryMethod: 'MANUAL' }),
    )

    // The scanner remounted (key bump) — a fresh instance, not the stale one.
    expect(screen.getByRole('button', { name: 'Simulate scan' })).not.toBe(scanButton)
  })
})

/**
 * Пошук за назвою в зовнішніх каталогах — погоджене розширення §6.3
 * (`docs/plan/stage-9-external-title-search.md`).
 */
describe('зовнішній пошук за назвою', () => {
  const externalEdition = {
    id: 'GOOGLE_BOOKS:v1',
    kind: 'EDITION' as const,
    sources: ['GOOGLE_BOOKS' as const],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    isbn13: '9786177585113',
    publishedYear: 2019,
    publisher: 'Смолоскип',
    language: 'uk' as const,
  }

  const externalWork = {
    id: 'OPEN_LIBRARY:OL1W',
    kind: 'WORK' as const,
    sources: ['OPEN_LIBRARY' as const],
    title: 'Сад Гетсиманський',
    authors: ['Іван Багряний'],
    firstPublishedYear: 1950,
    workExternalId: 'OL1W',
  }

  async function searchFor(query: string) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), query)
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    return user
  }

  it('локальні результати з’являються, поки зовнішні ще йдуть', async () => {
    const external = deferred<{ results: unknown[]; sources: unknown[] }>()

    routeApi({
      '/catalog/search/external': () => external.promise,
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    // Локальна картка вже на екрані, хоча зовнішній запит ще не повернувся —
    // це і є вимога «локальні результати не залежать від швидкості зовнішніх».
    expect(await screen.findByRole('button', { name: 'Це моє видання' })).toBeInTheDocument()
    expect(screen.getByText('Шукаю ще в Open Library та Google Books…')).toBeInTheDocument()

    external.resolve({
      results: [externalWork],
      sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
    })

    expect(await screen.findByText('Сад Гетсиманський')).toBeInTheDocument()
  })

  it('показує запис без ISBN як придатний результат', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalWork],
          sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Сад')

    expect(await screen.findByText('Сад Гетсиманський')).toBeInTheDocument()
    expect(
      screen.getByText('Запис про твір — ISBN конкретного видання доведеться вписати вручну'),
    ).toBeInTheDocument()
  })

  it('називає недоступне джерело поіменно, не ховаючи результати живого', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'ERROR' },
            { source: 'GOOGLE_BOOKS', status: 'OK' },
          ],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Тигролови')

    expect(await screen.findByText(/Open Library зараз недоступна/)).toBeInTheDocument()
    expect(screen.getByText('Тигролови')).toBeInTheDocument()
  })

  it('збій зовнішнього пошуку не блокує ручне додавання', async () => {
    routeApi({
      '/catalog/search/external': () => Promise.reject(new Error('мережа лягла')),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    const callbacks = renderSearch()
    const user = await searchFor('Тигролови')

    await user.click(await screen.findByRole('button', { name: 'Створити новий твір' }))

    expect(callbacks.onCreateNew).toHaveBeenCalledWith({
      initialTitle: 'Тигролови',
      entryMethod: 'MANUAL',
    })
  })

  it('вибір зовнішнього запису без дублікатів одразу заповнює форму створення', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition],
          sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    const callbacks = renderSearch()
    const user = await searchFor('Тигролови')

    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    await waitFor(() =>
      expect(callbacks.onCreateNew).toHaveBeenCalledWith({
        initialTitle: 'Тигролови',
        entryMethod: 'MANUAL',
        isbn: '9786177585113',
        lookup: {
          title: 'Тигролови',
          authors: ['Іван Багряний'],
          language: 'uk',
          publishedYear: 2019,
          publisher: 'Смолоскип',
          source: 'GOOGLE_BOOKS',
        },
      }),
    )
  })

  it('запис про твір не приносить у форму ні ISBN, ні року видання', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalWork],
          sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    const callbacks = renderSearch()
    const user = await searchFor('Сад')

    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    await waitFor(() => expect(callbacks.onCreateNew).toHaveBeenCalled())

    const [selection] = callbacks.onCreateNew.mock.calls[0] as [Record<string, unknown>]
    expect(selection).not.toHaveProperty('isbn')
    // 1950 — рік першої публікації ТВОРУ, а не тиражу в руках користувача.
    expect(selection.lookup).not.toHaveProperty('publishedYear')
  })

  it('перед створенням шукає дублікати за ISBN і пропонує наявне видання', async () => {
    const candidateQueries: string[] = []

    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition],
          sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    // Після вибору картки перевірка дублікатів мусить спитати саме за ISBN.
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({
          results: [externalEdition],
          sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        })
      }

      const query = decodeURIComponent(path.split('q=')[1] ?? '')
      candidateQueries.push(query)

      return Promise.resolve({
        candidates: query === externalEdition.isbn13 ? [candidate] : [],
      })
    })

    const callbacks = renderSearch()
    const user = await searchFor('Тигролови')

    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    expect(await screen.findByText(/Видання з таким ISBN уже є у BookSwap/)).toBeInTheDocument()
    expect(candidateQueries).toContain(externalEdition.isbn13)
    expect(callbacks.onCreateNew).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Це моє видання' }))

    expect(callbacks.onFoundEdition).toHaveBeenCalledWith({
      workId: 'work-1',
      title: 'Кобзар',
      editionId: 'edition-1',
      entryMethod: 'MANUAL',
    })
  })

  it('дублікат лише за назвою подається як питання, а не як висновок', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({
          results: [externalWork],
          sources: [{ source: 'OPEN_LIBRARY', status: 'OK' }],
        })
      }

      const query = decodeURIComponent(path.split('q=')[1] ?? '')

      return Promise.resolve({ candidates: query === 'Сад' ? [] : [candidate] })
    })

    const callbacks = renderSearch()
    const user = await searchFor('Сад')

    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    const panel = (await screen.findByText(/Схожі твори вже є у BookSwap/)).closest('section')
    expect(panel).not.toBeNull()

    // Збіг назви нічого не доводить — вихід «це інша книжка» лишається.
    // Запит обмежений панеллю: така сама кнопка є і в локальній секції вище.
    await user.click(
      within(panel as HTMLElement).getByRole('button', { name: 'Створити новий твір' }),
    )
    expect(callbacks.onCreateNew).toHaveBeenCalled()
  })

  it('збій перевірки дублікатів не замуровує користувача', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({
          results: [externalEdition],
          sources: [{ source: 'GOOGLE_BOOKS', status: 'OK' }],
        })
      }

      return screen.queryByText(/Обрано/) === null
        ? Promise.resolve({ candidates: [] })
        : Promise.reject(new Error('пошук кандидатів недоступний'))
    })

    const callbacks = renderSearch()
    const user = await searchFor('Тигролови')

    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))

    expect(
      await screen.findByText(/Не вдалося перевірити, чи така книжка вже є у BookSwap/),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Усе одно створити новий твір' }))
    expect(callbacks.onCreateNew).toHaveBeenCalled()
  })

  it('запит, що сам є ISBN, зовнішній пошук за назвою не запускає', async () => {
    const paths: string[] = []

    mockApiRequest.mockImplementation((path: string) => {
      paths.push(path)

      return path.startsWith('/catalog/lookup')
        ? Promise.resolve({ result: lookup })
        : Promise.resolve({ candidates: [candidate] })
    })

    renderSearch(ISBN)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    await screen.findByText('точний збіг за ISBN')

    // Чинна поведінка за ISBN незмінна: кандидати + /catalog/lookup, і ніякої
    // третьої витрати чужої квоти на те саме питання.
    expect(paths.some((path) => path.startsWith('/catalog/search/external'))).toBe(false)
  })
})

/**
 * Regressions found in review. Each one needs a response that resolves on
 * command, because the defect only appears while a request is still in flight.
 */
describe('перегони запитів і вибору', () => {
  const externalEdition = {
    id: 'GOOGLE_BOOKS:v1',
    kind: 'EDITION' as const,
    sources: ['GOOGLE_BOOKS' as const],
    title: 'Тигролови',
    authors: ['Іван Багряний'],
    isbn13: '9786177585113',
    publishedYear: 2019,
    publisher: 'Смолоскип',
  }

  const externalWork = {
    id: 'OPEN_LIBRARY:OL1W',
    kind: 'WORK' as const,
    sources: ['OPEN_LIBRARY' as const],
    title: 'Сад Гетсиманський',
    authors: ['Іван Багряний'],
    firstPublishedYear: 1950,
    workExternalId: 'OL1W',
  }

  const oneSource = [{ source: 'GOOGLE_BOOKS', status: 'OK' }]

  async function pickExternal(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: 'Вибрати це видання' }))
  }

  it('новий пошук знецінює перевірку дублікатів, що вже в польоті', async () => {
    const dupCheck = deferred<{ candidates: WorkDetailResponse[] }>()
    let selectionStarted = false

    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalEdition], sources: oneSource })
      }

      // The first candidate call belongs to the search itself; the next one is
      // the duplicate check, and that is the one held open.
      if (!selectionStarted) return Promise.resolve({ candidates: [] })

      return dupCheck.promise
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    selectionStarted = true
    await pickExternal(user)
    expect(await screen.findByText(/Перевіряю, чи така книжка вже є/)).toBeInTheDocument()

    // A new search while the check is still running abandons the selection.
    await user.clear(screen.getByLabelText('Назва або ISBN'))
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Інша книжка')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    // The stale check now answers "no duplicates". Before the fix this pushed
    // the wizard into the creation form for the abandoned record.
    dupCheck.resolve({ candidates: [] })
    await waitFor(() => {
      expect(screen.queryByText(/Перевіряю, чи така книжка вже є/)).not.toBeInTheDocument()
    })

    expect(callbacks.onCreateNew).not.toHaveBeenCalled()
  })

  it('демонтаж кроку теж знецінює перевірку, що вже в польоті', async () => {
    const dupCheck = deferred<{ candidates: WorkDetailResponse[] }>()
    let selectionStarted = false

    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalEdition], sources: oneSource })
      }
      if (!selectionStarted) return Promise.resolve({ candidates: [] })

      return dupCheck.promise
    })

    const callbacks = {
      onFoundEdition: jest.fn(),
      onFoundWork: jest.fn(),
      onCreateNew: jest.fn(),
    }
    const view = render(<SearchStep initialQuery="" {...callbacks} />)
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    selectionStarted = true
    await pickExternal(user)
    await screen.findByText(/Перевіряю, чи така книжка вже є/)

    view.unmount()
    dupCheck.resolve({ candidates: [] })

    // `findLocalDuplicates` awaits twice before calling back, so a single
    // microtask tick would assert before the callback could ever fire — and the
    // test would pass no matter what the code does.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(callbacks.onCreateNew).not.toHaveBeenCalled()
  })

  it('пошук за назвою після сканування позначається MANUAL, а не BARCODE', async () => {
    // The title search's own candidate request is never resolved, so the
    // component still holds the SCAN's results when the external card is
    // picked. That is the only moment the stale `scanState` could be read —
    // resolve it, and the state is already MANUAL and the bug invisible.
    const pendingLocal = deferred<{ candidates: WorkDetailResponse[] }>()
    let scanDone = false
    let afterScanCalls = 0

    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalEdition], sources: oneSource })
      }
      if (path.startsWith('/catalog/lookup')) return Promise.resolve({ result: lookup })
      if (!scanDone) return Promise.resolve({ candidates: [candidate] })

      afterScanCalls += 1

      // Call 1 is the title search itself — left hanging on purpose. Every
      // later call belongs to the duplicate check and must answer, or the
      // selection would never complete and the test would prove nothing.
      return afterScanCalls === 1 ? pendingLocal.promise : Promise.resolve({ candidates: [] })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()

    // A scan first, so `scanState.entryMethod` becomes BARCODE.
    await user.click(await screen.findByRole('button', { name: 'Simulate scan' }))
    await screen.findByRole('button', { name: 'Це моє видання' })
    scanDone = true

    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await pickExternal(user)

    await waitFor(() => expect(callbacks.onCreateNew).toHaveBeenCalled())
    expect(callbacks.onCreateNew).toHaveBeenCalledWith(
      expect.objectContaining({ entryMethod: 'MANUAL' }),
    )
  })

  it('вибір наявного твору передає його переклади далі', async () => {
    const withTranslation: WorkDetailResponse = {
      ...candidate,
      translations: [
        {
          id: 'translation-1',
          workId: 'work-1',
          lang: 'uk',
          sourceLang: 'en',
          translator: 'Перекладач',
          year: 2019,
          isAbridged: false,
          hasNotes: false,
          notes: null,
          editionCount: 1,
          revision: 1,
        },
      ],
    }

    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalWork], sources: oneSource })
      }

      const query = decodeURIComponent(path.split('q=')[1] ?? '')

      return Promise.resolve({ candidates: query === 'Сад' ? [] : [withTranslation] })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Сад')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await pickExternal(user)

    await screen.findByText(/Схожі твори вже є у BookSwap/)
    await user.click(screen.getByRole('button', { name: 'У мене інше видання цього твору' }))

    // Without this the TranslationStep shows no existing translations and the
    // user adds a second one for a language the work already has.
    expect(callbacks.onFoundWork).toHaveBeenCalledWith(
      expect.objectContaining({
        workId: 'work-1',
        existingTranslations: withTranslation.translations,
      }),
    )
  })

  it('рік першої публікації твору доходить до форми, а рік тиражу — ні', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalWork], sources: oneSource })
      }

      return Promise.resolve({ candidates: [] })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Сад')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await pickExternal(user)

    await waitFor(() => expect(callbacks.onCreateNew).toHaveBeenCalled())

    const [selection] = callbacks.onCreateNew.mock.calls[0] as [Record<string, unknown>]
    expect(selection.firstPubYear).toBe(1950)
    // `lookup` describes an edition; a work-level year must never land there.
    expect(selection.lookup).not.toHaveProperty('publishedYear')
  })

  it('рік ТИРАЖУ не стає роком першої публікації твору', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalEdition], sources: oneSource })
      }

      return Promise.resolve({ candidates: [] })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await pickExternal(user)

    await waitFor(() => expect(callbacks.onCreateNew).toHaveBeenCalled())

    const [selection] = callbacks.onCreateNew.mock.calls[0] as [Record<string, unknown>]
    expect(selection).not.toHaveProperty('firstPubYear')
    expect(selection.lookup).toMatchObject({ publishedYear: 2019 })
  })

  it('збій перевірки дублікатів дає окремий стан із повтором', async () => {
    let attempts = 0

    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [externalEdition], sources: oneSource })
      }
      if (attempts === 0) {
        attempts += 1
        return Promise.resolve({ candidates: [] })
      }

      attempts += 1

      return attempts === 2
        ? Promise.reject(new Error('пошук кандидатів недоступний'))
        : Promise.resolve({ candidates: [candidate] })
    })

    const callbacks = renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))
    await pickExternal(user)

    expect(await screen.findByText(/Дублікат не виключений/)).toBeInTheDocument()
    expect(callbacks.onCreateNew).not.toHaveBeenCalled()

    // Retrying must re-run the check, not fall through to creation.
    await user.click(screen.getByRole('button', { name: 'Повторити перевірку' }))

    expect(await screen.findByText(/Видання з таким ISBN уже є у BookSwap/)).toBeInTheDocument()
    expect(callbacks.onCreateNew).not.toHaveBeenCalled()
  })

  it('власне обмеження частоти не подається як збій каталогу', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({
          results: [],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'RATE_LIMITED' },
            { source: 'GOOGLE_BOOKS', status: 'OK' },
          ],
        })
      }

      return Promise.resolve({ candidates: [] })
    })

    renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    expect(await screen.findByText(/ліміт звернень/)).toBeInTheDocument()
    expect(screen.queryByText(/Open Library зараз недоступна/)).not.toBeInTheDocument()
    // Google Books answered, so this is not "no source replied".
    expect(screen.queryByText(/Жодне зовнішнє джерело не відповіло/)).not.toBeInTheDocument()
  })

  it('порожній список джерел не читається як «жодне не відповіло»', async () => {
    mockApiRequest.mockImplementation((path: string) => {
      if (path.startsWith('/catalog/search/external')) {
        return Promise.resolve({ results: [], sources: [] })
      }

      return Promise.resolve({ candidates: [] })
    })

    renderSearch()
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), 'Тигролови')
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    // Порожній `sources` означає, що жодного джерела не питали, а не що всі
    // впали, — тож це звичайне «нічого не знайшлося», без застереження.
    expect(
      await screen.findByText('Нічого схожого не знайшлося. Заведемо новий твір.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/зовнішні каталоги не відповіли/i)).not.toBeInTheDocument()
  })
})

describe('спільний список результатів', () => {
  const externalEdition = {
    id: 'GOOGLE_BOOKS:v1',
    kind: 'EDITION' as const,
    sources: ['GOOGLE_BOOKS' as const],
    title: 'Кобзар',
    authors: ['Тарас Шевченко'],
    publishedYear: 2021,
    publisher: 'А-БА-БА-ГА-ЛА-МА-ГА',
  }

  const okSources = [
    { source: 'OPEN_LIBRARY', status: 'OK' },
    { source: 'GOOGLE_BOOKS', status: 'OK' },
  ]

  async function searchFor(query: string) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), query)
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    return user
  }

  /**
   * The cards of the one and only results list.
   *
   * Direct children only: a local card nests its own editions in a second
   * `<ul>`, and `getAllByRole('listitem')` would count those as cards too.
   */
  function cardsInList(): HTMLElement[] {
    const lists = screen.getAllByRole('list').filter((list) => list.classList.contains('books'))

    expect(lists).toHaveLength(1)

    return [...(lists[0] as HTMLElement).querySelectorAll(':scope > li')] as HTMLElement[]
  }

  it('малює локальну й зовнішню картку в одному списку', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: okSources }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    await screen.findByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })

    const cards = cardsInList()
    expect(cards).toHaveLength(2)
    expect(
      cards.map((card) => within(card).getByText(/Наш каталог|Google Books/).textContent),
    ).toEqual(['Наш каталог', 'Google Books'])
  })

  it('позначає походження кожної картки бейджем', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [
            externalEdition,
            { ...externalEdition, id: 'OPEN_LIBRARY:OL1W', sources: ['OPEN_LIBRARY'] },
          ],
          sources: okSources,
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    expect(await screen.findByText('Open Library')).toBeInTheDocument()
    expect(screen.getByText('Google Books')).toBeInTheDocument()
  })

  it('зовнішні результати ДОПОВНЮЮТЬ список, а не замінюють локальні', async () => {
    const external = deferred<{ results: unknown[]; sources: unknown[] }>()

    routeApi({
      '/catalog/search/external': () => external.promise,
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    // Локальна картка вже на екрані; «нічого не знайдено» ще не сказано, бо
    // зовнішні джерела ще не відповіли.
    expect(await screen.findByRole('button', { name: 'Це моє видання' })).toBeInTheDocument()
    expect(cardsInList()).toHaveLength(1)
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()

    act(() => {
      external.resolve({ results: [externalEdition], sources: okSources })
    })

    await waitFor(() => {
      expect(cardsInList()).toHaveLength(2)
    })
    expect(screen.getByRole('button', { name: 'Це моє видання' })).toBeInTheDocument()
  })

  it('часткова недоступність джерела не ховає того, що знайдено', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [externalEdition],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
            { source: 'GOOGLE_BOOKS', status: 'OK' },
          ],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    expect(await screen.findByText(/Open Library не відповіла вчасно/)).toBeInTheDocument()
    expect(cardsInList()).toHaveLength(2)
  })

  it('локальна картка має пріоритет над зовнішньою з тим самим ISBN', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [{ ...externalEdition, isbn13: ISBN }],
          sources: okSources,
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    await screen.findByRole('button', { name: 'Це моє видання' })

    const cards = cardsInList()
    expect(cards).toHaveLength(1)
    expect(within(cards[0] as HTMLElement).getByText('Наш каталог')).toBeInTheDocument()
  })

  it('різні видання того самого твору лишаються окремими картками', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [
            {
              ...externalEdition,
              id: 'GOOGLE_BOOKS:a',
              isbn13: '9786177585113',
              publishedYear: 2019,
            },
            {
              ...externalEdition,
              id: 'GOOGLE_BOOKS:b',
              isbn13: '9789660303072',
              publishedYear: 2021,
            },
          ],
          sources: okSources,
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    await screen.findByText('ISBN 9786177585113')
    expect(cardsInList()).toHaveLength(2)
  })

  it('«нічого не знайдено» чекає на завершення зовнішнього пошуку', async () => {
    const external = deferred<{ results: unknown[]; sources: unknown[] }>()

    routeApi({
      '/catalog/search/external': () => external.promise,
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    expect(await screen.findByText('Шукаю ще в Open Library та Google Books…')).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()

    act(() => {
      external.resolve({ results: [], sources: okSources })
    })

    expect(
      await screen.findByText('Нічого схожого не знайшлося. Заведемо новий твір.'),
    ).toBeInTheDocument()
  })

  it('порожня видача й недоступність джерел читаються по-різному', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({
          results: [],
          sources: [
            { source: 'OPEN_LIBRARY', status: 'TIMEOUT' },
            { source: 'GOOGLE_BOOKS', status: 'ERROR' },
          ],
        }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    expect(await screen.findByText(/чи є там ця книжка, невідомо/)).toBeInTheDocument()
    expect(screen.queryByText(/Нічого схожого не знайшлося/)).not.toBeInTheDocument()
  })
})

/**
 * `/catalog/new` мусить поводитися з обкладинками так само, як `/catalog`:
 * той самий `BookCover` під усіма картками — локальними, зовнішніми та
 * карткою пошуку за ISBN.
 */
describe('обкладинки в результатах', () => {
  const COVER_URL = 'https://covers.openlibrary.org/b/id/42-M.jpg'

  const externalEdition = {
    id: 'GOOGLE_BOOKS:v1',
    kind: 'EDITION' as const,
    sources: ['GOOGLE_BOOKS' as const],
    title: 'Кобзар',
    authors: ['Тарас Шевченко'],
    publishedYear: 2021,
    publisher: 'А-БА-БА-ГА-ЛА-МА-ГА',
  }

  const okSources = [
    { source: 'OPEN_LIBRARY', status: 'OK' },
    { source: 'GOOGLE_BOOKS', status: 'OK' },
  ]

  /** Заглушка навмисно `aria-hidden`, тож шукаємо її за класом розмітки. */
  function placeholders(): Element[] {
    return [...document.querySelectorAll('.lookup-card__cover--empty')]
  }

  async function searchFor(query: string) {
    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Назва або ISBN'), query)
    await user.click(screen.getByRole('button', { name: 'Шукати' }))

    return user
  }

  it('без обкладинки показує заглушку — і в локальній, і в зовнішній картці', async () => {
    routeApi({
      '/catalog/search/external': () =>
        Promise.resolve({ results: [externalEdition], sources: okSources }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [candidate] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    await screen.findByText('А-БА-БА-ГА-ЛА-МА-ГА', { exact: false })

    expect(placeholders()).toHaveLength(2)
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('наявну обкладинку показує як раніше', async () => {
    const withCover = {
      ...candidate,
      editions: [{ ...candidate.editions[0]!, coverUrl: COVER_URL }],
    }

    routeApi({
      '/catalog/search/external': () => Promise.resolve({ results: [], sources: okSources }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [withCover] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    const cover = await screen.findByAltText('Обкладинка «Кобзар»')
    expect(cover).toHaveAttribute('src', COVER_URL)
    expect(placeholders()).toHaveLength(0)
  })

  it('якщо обкладинка не завантажилася, на її місці зʼявляється заглушка', async () => {
    const withCover = {
      ...candidate,
      editions: [{ ...candidate.editions[0]!, coverUrl: COVER_URL }],
    }

    routeApi({
      '/catalog/search/external': () => Promise.resolve({ results: [], sources: okSources }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [withCover] }),
    })

    renderSearch()
    await searchFor('Кобзар')

    fireEvent.error(await screen.findByAltText('Обкладинка «Кобзар»'))

    // Та сама коробка: рядок не змінює розмір через збій завантаження.
    expect(placeholders()).toHaveLength(1)
    expect(placeholders()[0]).toHaveClass('lookup-card__cover')
    expect(screen.queryByAltText('Обкладинка «Кобзар»')).toBeNull()
  })

  it('картка пошуку за ISBN без обкладинки теж показує заглушку', async () => {
    routeApi({
      '/catalog/lookup': () => Promise.resolve({ result: lookup }),
      '/catalog/search/candidates': () => Promise.resolve({ candidates: [] }),
    })

    renderSearch()
    await searchFor(ISBN)

    // Пошук за ISBN зовнішнього пошуку за назвою не запускає — на екрані сама
    // картка знахідки, і в неї теж є ліва колонка.
    await screen.findByText('Lookup title')
    expect(placeholders()).toHaveLength(1)
  })
})
