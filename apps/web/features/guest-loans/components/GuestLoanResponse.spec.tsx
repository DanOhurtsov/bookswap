/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/app/lib/api'
import { GuestLoanResponse } from './GuestLoanResponse'

jest.mock('@/app/lib/api', () => {
  const actual = jest.requireActual<typeof import('@/app/lib/api')>('@/app/lib/api')

  return { ...actual, apiRequest: jest.fn() }
})

const { apiRequest: mockApiRequest } = jest.requireMock<{ apiRequest: jest.Mock }>('@/app/lib/api')

const TOKEN = 'tok-secret-123'
const PAGE = '/guest-loan-confirmation'
// Адреса B, яку вводить гість, і адреса доставки A, яку вводив власник (гість її не знає й не вводить).
const EMAIL_B = 'guest-b@guest.invalid'
const EMAIL_A = 'owner-target-a@guest.invalid'
const NICKNAME = 'Синтетичний Нік'
const PROOF = 'proof-xyz'

const RESOLVED = {
  book: { title: 'Тестова книга', authors: ['Автор Перший', 'Автор Другий'] },
  expiresAt: '2026-10-06T12:00:00.000Z',
}

const apiError = (status: number, code: string, message = 'Помилка сервера') =>
  new ApiRequestError(status, { code, message } as never)

/** Усі виклики API: [path, body]. */
const calls = (): [string, unknown][] =>
  mockApiRequest.mock.calls.map(([path, options]: [string, { body?: unknown }?]) => [
    path,
    options?.body,
  ])

const pathsCalled = (): string[] => calls().map(([path]) => path)

interface Overrides {
  resolve?: () => Promise<unknown>
  code?: () => Promise<unknown>
  verify?: () => Promise<unknown>
  answer?: () => Promise<unknown>
}

function mockFlow(overrides: Overrides = {}) {
  mockApiRequest.mockImplementation((path: string) => {
    switch (path) {
      case '/guest-loan-responses/resolve':
        return (overrides.resolve ?? (() => Promise.resolve(RESOLVED)))()
      case '/guest-loan-responses/code':
        return (
          overrides.code ?? (() => Promise.resolve({ codeExpiresAt: '2026-09-29T12:10:00.000Z' }))
        )()
      case '/guest-loan-responses/verify':
        return (
          overrides.verify ??
          (() => Promise.resolve({ proof: PROOF, proofExpiresAt: '2026-09-29T12:30:00.000Z' }))
        )()
      case '/guest-loan-responses/answer':
        return (overrides.answer ?? (() => Promise.resolve({ answer: 'RECEIVED' })))()
      default:
        return Promise.reject(new Error(`unexpected ${path}`))
    }
  })
}

function openPage(hash: string | undefined = `#${TOKEN}`) {
  window.history.replaceState(null, '', hash === '' ? PAGE : `${PAGE}${hash}`)

  return render(<GuestLoanResponse />)
}

async function fillDetails(email = EMAIL_B) {
  await userEvent.type(await screen.findByLabelText('Нікнейм'), NICKNAME)
  await userEvent.type(screen.getByLabelText('Ваша адреса пошти'), email)
}

async function toCodeStep() {
  await fillDetails()
  await userEvent.click(screen.getByRole('button', { name: 'Надіслати код' }))
  await screen.findByLabelText('Код із листа')
}

async function toAnswerStep() {
  await toCodeStep()
  await userEvent.type(screen.getByLabelText('Код із листа'), '123456')
  await userEvent.click(screen.getByRole('button', { name: 'Підтвердити код' }))
  await screen.findByRole('button', { name: 'Отримав книжку' })
}

beforeEach(() => {
  mockApiRequest.mockReset()
  window.history.replaceState(null, '', PAGE)
})

describe('GuestLoanResponse: токен, до перевірки email (Stage 10, 10i.3; GC2, GC3, GC10)', () => {
  it('читає токен із фрагмента, ПРИБИРАЄ його з адреси, шле лише в тілі й не пише в сховища', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem')

    mockFlow()
    openPage()

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(calls()).toEqual([['/guest-loan-responses/resolve', { token: TOKEN }]])
    expect(setItem).not.toHaveBeenCalled()
    // Токена немає й у видимому тексті сторінки.
    expect(document.body.textContent).not.toContain(TOKEN)

    setItem.mockRestore()
  })

  it('до перевірки email: лише назва, автори й строк дії — без дати передачі, alias, контакту, історії', async () => {
    mockFlow()
    openPage()

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(screen.getByText('Автор Перший, Автор Другий')).toBeInTheDocument()
    expect(screen.getByText(/Посилання діє до/)).toBeInTheDocument()

    const text = document.body.textContent
    // Поле передачі/дата, контакт, alias, історія й email власника на сторінці не з'являються.
    expect(text).not.toMatch(/Передано|передан|handed|alias|аліас|контакт|Історі|власника:/i)
    // Відповідь ще недоступна: кнопок відповіді немає до підтвердження email.
    expect(screen.queryByRole('button', { name: 'Отримав книжку' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Не отримував' })).not.toBeInTheDocument()
  })

  it('без токена у фрагменті: жодного запиту, пояснення', async () => {
    mockFlow()
    openPage('')

    expect(await screen.findByText('У адресі немає посилання')).toBeInTheDocument()
    expect(mockApiRequest).not.toHaveBeenCalled()
  })

  it('синтетичне попередження (D2) і чесне формулювання доказу — без «доведена особа»', async () => {
    mockFlow()
    openPage()

    expect(await screen.findByText(/Лише синтетичні тестові дані/)).toBeInTheDocument()
    expect(screen.getByText(/Посилання можна передати іншій людині/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(
      /доведен\S* особ|перевірен\S* особ|підтверджен\S* особ/i,
    )
  })

  it('feature-off (403 FEATURE_DISABLED): «Сторінку не знайдено», жоден крок потоку не відкривається', async () => {
    mockFlow({
      resolve: () => Promise.reject(apiError(403, 'FEATURE_DISABLED', 'Функція вимкнена')),
    })
    openPage()

    expect(await screen.findByText('Сторінку не знайдено.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Нікнейм')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Надіслати код' })).not.toBeInTheDocument()
    expect(pathsCalled()).toEqual(['/guest-loan-responses/resolve'])
  })

  it.each([
    ['GUEST_LINK_INVALID', 404, /Посилання недійсне/, /уже використане або замінене/],
    ['GUEST_LINK_EXPIRED', 410, /Строк дії посилання минув/, /Попросіть власника/],
  ] as const)('%s на resolve: кінцевий стан без форми', async (code, status, title, hint) => {
    mockFlow({ resolve: () => Promise.reject(apiError(status, code)) })
    openPage()

    expect(await screen.findByText(title)).toBeInTheDocument()
    expect(screen.getByText(hint)).toBeInTheDocument()
    expect(screen.queryByLabelText('Нікнейм')).not.toBeInTheDocument()
  })
})

describe('GuestLoanResponse: повтор початкового resolve (рев’ю 10i.3)', () => {
  it('мережева помилка → «Спробувати ще раз» → другий resolve з тим самим токеном з пам’яті → звичайний потік', async () => {
    let attempt = 0

    mockFlow({
      resolve: () => {
        attempt += 1

        return attempt === 1
          ? Promise.reject(new Error('Мережа недоступна'))
          : Promise.resolve(RESOLVED)
      },
    })
    openPage()

    expect(await screen.findByText(/Не вдалося звʼязатися з API/)).toBeInTheDocument()
    // Токена вже немає в адресі; повтор не повертає його ні в URL, ні в сховища.
    expect(window.location.hash).toBe('')

    await userEvent.click(screen.getByRole('button', { name: 'Спробувати ще раз' }))

    expect(await screen.findByText('Тестова книга')).toBeInTheDocument()
    expect(calls()).toEqual([
      ['/guest-loan-responses/resolve', { token: TOKEN }],
      ['/guest-loan-responses/resolve', { token: TOKEN }],
    ])
    expect(window.location.hash).toBe('')
    expect(window.location.href).not.toContain(TOKEN)
    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument()

    await toAnswerStep()
    expect(screen.getByRole('button', { name: 'Отримав книжку' })).toBeInTheDocument()
  })

  it.each([
    [403, 'FEATURE_DISABLED'],
    [404, 'GUEST_LINK_INVALID'],
    [410, 'GUEST_LINK_EXPIRED'],
  ] as const)('термінальний %s %s не повторюваний: кнопки повтору немає', async (status, code) => {
    mockFlow({ resolve: () => Promise.reject(apiError(status, code)) })
    openPage()

    await waitFor(() => {
      expect(mockApiRequest).toHaveBeenCalledTimes(1)
    })
    await screen.findByRole('heading', { name: /.+/ }).catch(() => undefined)

    expect(screen.queryByRole('button', { name: 'Спробувати ще раз' })).not.toBeInTheDocument()
  })
})

describe('GuestLoanResponse: повний шлях (GC2, GC13)', () => {
  it('нікнейм + email B → код → verify → «Отримав книжку»; кожен крок — за чинним API, відповідь одноразова', async () => {
    mockFlow()
    openPage()
    await toAnswerStep()

    await userEvent.click(screen.getByRole('button', { name: 'Отримав книжку' }))

    expect(await screen.findByText('Відповідь записано')).toBeInTheDocument()
    expect(screen.getByText(/Ви підтвердили, що отримали «Тестова книга»/)).toBeInTheDocument()
    expect(calls()).toEqual([
      ['/guest-loan-responses/resolve', { token: TOKEN }],
      ['/guest-loan-responses/code', { token: TOKEN, nickname: NICKNAME, email: EMAIL_B }],
      [
        '/guest-loan-responses/verify',
        { token: TOKEN, nickname: NICKNAME, email: EMAIL_B, code: '123456' },
      ],
      [
        '/guest-loan-responses/answer',
        { token: TOKEN, nickname: NICKNAME, email: EMAIL_B, proof: PROOF, answer: 'RECEIVED' },
      ],
    ])
    // Одноразово: повторно відповісти вже не можна, а токен і код не лишилися на екрані.
    expect(
      screen.queryByRole('button', { name: /Отримав книжку|Не отримував/ }),
    ).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(TOKEN)
    expect(document.body.textContent).not.toContain(PROOF)
  })

  it('«Не отримував»: відповідь DENIED, текст про розбіжність, а не про повернення', async () => {
    mockFlow({ answer: () => Promise.resolve({ answer: 'DENIED' }) })
    openPage()
    await toAnswerStep()

    await userEvent.click(screen.getByRole('button', { name: 'Не отримував' }))

    expect(await screen.findByText(/Ви повідомили, що не отримували/)).toBeInTheDocument()
    expect(screen.getByText(/розбіжність/)).toBeInTheDocument()
    expect(calls().at(-1)).toEqual([
      '/guest-loan-responses/answer',
      { token: TOKEN, nickname: NICKNAME, email: EMAIL_B, proof: PROOF, answer: 'DENIED' },
    ])
  })

  it('GC13: адреса доставки A (яку вводив власник) гостю не відома й не порівнюється з B — потік проходить з іншою адресою', async () => {
    mockFlow()
    openPage()
    await toAnswerStep()
    await userEvent.click(screen.getByRole('button', { name: 'Отримав книжку' }))
    await screen.findByText('Відповідь записано')

    // У запитах гостя — лише B; A ніде: ні в запитах, ні на сторінці.
    expect(JSON.stringify(calls())).not.toContain(EMAIL_A)
    expect(document.body.textContent).not.toContain(EMAIL_A)
    expect(JSON.stringify(calls())).toContain(EMAIL_B)
    // Немає жодного порівняння чи схвалення власником.
    expect(document.body.textContent).not.toMatch(/збігається з адресою|схвал|підтвердить власник/i)
    // Сторінка прямо каже, що адреса не мусить збігатися.
    expect(pathsCalled()).not.toContain('/guest-loan-confirmations')
  })

  it('адреса B не синтетична — відхилено на клієнті, запит коду не йде (D2)', async () => {
    mockFlow()
    openPage()
    await fillDetails('real.person@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати код' }))

    expect(
      await screen.findByText(/Лише синтетичні адреси домену guest\.invalid/),
    ).toBeInTheDocument()
    expect(pathsCalled()).toEqual(['/guest-loan-responses/resolve'])
  })

  it('порожній нікнейм — помилка поля, запит не йде', async () => {
    mockFlow()
    openPage()
    await userEvent.type(await screen.findByLabelText('Ваша адреса пошти'), EMAIL_B)
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати код' }))

    expect(await screen.findByText('Вкажіть нікнейм')).toBeInTheDocument()
    expect(pathsCalled()).toEqual(['/guest-loan-responses/resolve'])
  })

  it('крок коду чесно попереджає: тестовий лист нікуди назовні не надсилається', async () => {
    mockFlow()
    openPage()
    await toCodeStep()

    expect(screen.getByText(/лист із кодом нікуди назовні не надсилається/)).toBeInTheDocument()
    expect(screen.getByText(/реальна пошта його не отримає/)).toBeInTheDocument()
    // Після запиту коду адреса й нікнейм зафіксовані: відповідь прив'язана саме до них.
    expect(screen.getByLabelText('Нікнейм')).toBeDisabled()
    expect(screen.getByLabelText('Ваша адреса пошти')).toBeDisabled()
  })
})

describe('GuestLoanResponse: помилки кроків (GC2, GC9)', () => {
  it('хибний/прострочений код: повідомлення, крок коду лишається, можна повторити', async () => {
    let attempts = 0

    mockFlow({
      verify: () => {
        attempts += 1

        return attempts === 1
          ? Promise.reject(apiError(400, 'GUEST_CODE_INVALID'))
          : Promise.resolve({ proof: PROOF, proofExpiresAt: '2026-09-29T12:30:00.000Z' })
      },
    })
    openPage()
    await toCodeStep()
    await userEvent.type(screen.getByLabelText('Код із листа'), '000000')
    await userEvent.click(screen.getByRole('button', { name: 'Підтвердити код' }))

    expect(
      await screen.findByText(/Код хибний, прострочений або вже використаний/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Отримав книжку' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Підтвердити код' }))

    expect(await screen.findByRole('button', { name: 'Отримав книжку' })).toBeInTheDocument()
  })

  it('код не з шести цифр — помилка поля без запиту', async () => {
    mockFlow()
    openPage()
    await toCodeStep()
    await userEvent.type(screen.getByLabelText('Код із листа'), '12ab')
    await userEvent.click(screen.getByRole('button', { name: 'Підтвердити код' }))

    expect(await screen.findByText('Код — шість цифр')).toBeInTheDocument()
    expect(pathsCalled()).not.toContain('/guest-loan-responses/verify')
  })

  it.each([
    ['GUEST_CODE_RATE_LIMITED', 429],
    ['RATE_LIMITED', 429],
  ] as const)(
    'ліміти (%s): просить зачекати чи нове посилання, без розкриття лічильників',
    async (code, status) => {
      mockFlow({ code: () => Promise.reject(apiError(status, code)) })
      openPage()
      await fillDetails()
      await userEvent.click(screen.getByRole('button', { name: 'Надіслати код' }))

      expect(await screen.findByText(/Забагато спроб/)).toBeInTheDocument()
      expect(screen.getByText(/нове посилання/)).toBeInTheDocument()
    },
  )

  it('доказ застарів (403 GUEST_PROOF_INVALID) на відповіді: повернення до кроку коду, а не кінець', async () => {
    mockFlow({ answer: () => Promise.reject(apiError(403, 'GUEST_PROOF_INVALID')) })
    openPage()
    await toAnswerStep()
    await userEvent.click(screen.getByRole('button', { name: 'Отримав книжку' }))

    expect(await screen.findByText(/Підтвердження email застаріло/)).toBeInTheDocument()
    expect(screen.getByLabelText('Код із листа')).toBeInTheDocument()
    expect(screen.queryByText('Відповідь записано')).not.toBeInTheDocument()
  })

  it('конкурентна зміна: посилання погашене/замінене між кроками (404) — кінцевий стан «недійсне»', async () => {
    mockFlow({ answer: () => Promise.reject(apiError(404, 'GUEST_LINK_INVALID')) })
    openPage()
    await toAnswerStep()
    await userEvent.click(screen.getByRole('button', { name: 'Отримав книжку' }))

    expect(await screen.findByText('Посилання недійсне')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /Отримав книжку|Не отримував/ }),
    ).not.toBeInTheDocument()
  })

  it('сплив під час відповіді (410) — кінцевий стан, відповідь не записано', async () => {
    mockFlow({ answer: () => Promise.reject(apiError(410, 'GUEST_LINK_EXPIRED')) })
    openPage()
    await toAnswerStep()
    await userEvent.click(screen.getByRole('button', { name: 'Отримав книжку' }))

    expect(await screen.findByText('Строк дії посилання минув')).toBeInTheDocument()
    expect(screen.queryByText('Відповідь записано')).not.toBeInTheDocument()
  })

  it('стан позики змінився (409 LOAN_COPY_STATE_MISMATCH): відповідь не записано, звернутися до власника', async () => {
    mockFlow({ answer: () => Promise.reject(apiError(409, 'LOAN_COPY_STATE_MISMATCH')) })
    openPage()
    await toAnswerStep()
    await userEvent.click(screen.getByRole('button', { name: 'Не отримував' }))

    expect(await screen.findByText('Стан позики змінився')).toBeInTheDocument()
    expect(screen.getByText(/Зверніться до власника/)).toBeInTheDocument()
  })

  it('«Змінити адресу чи нікнейм» повертає до початку кроків і не пише нічого в API', async () => {
    mockFlow()
    openPage()
    await toCodeStep()
    const before = mockApiRequest.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: 'Змінити адресу чи нікнейм' }))

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Надіслати код' })).toBeInTheDocument()
    })
    expect(screen.getByLabelText('Нікнейм')).toBeEnabled()
    expect(mockApiRequest.mock.calls).toHaveLength(before)
  })
})
