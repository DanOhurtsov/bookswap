import { ConfigService } from '@nestjs/config'
import { ResendEmailSender } from './resend-email-sender'
import type { EmailMessage } from './email-sender'

const CONFIG_VALUES: Record<string, string> = {
  RESEND_API_KEY: 're_test_key_123',
  EMAIL_FROM: 'BookSwap <bookswap@example.com>',
}

function config(): ConfigService {
  return {
    getOrThrow: (key: string) => {
      const value = CONFIG_VALUES[key]

      if (value === undefined) throw new Error(`Немає значення для ${key}`)

      return value
    },
  } as unknown as ConfigService
}

const message: EmailMessage = {
  to: 'marta@example.com',
  subject: 'BookSwap: підтвердіть адресу',
  body: 'Посилання: http://localhost:3000/verify-email?token=SEKRET',
}

/** Мінімальна форма `Response`, якою користується `send()`. */
function okResponse(): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
  } as unknown as Response
}

/**
 * §7.2 і §7.3: `ResendEmailSender` — реалізація порту `EmailSender`, яка йде
 * назовні. §11 забороняє реальні мережеві виклики в тестах, тож `fetch`
 * підмінений цілком — жодного звернення до api.resend.com.
 */
describe('ResendEmailSender', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn()
    // `fetch` — глобальний у Node 22, підміняємо саме його, а не окремий модуль.
    global.fetch = fetchMock
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('запечатаний лист гостьового підтвердження (10i.2, D2) не йде назовні: відмова без fetch', async () => {
    await expect(
      new ResendEmailSender(config()).send({ ...message, sealed: true }),
    ).rejects.toThrow(/Запечатаний лист/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('надсилає POST на ендпоінт Resend з Authorization: Bearer <ключ>', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await new ResendEmailSender(config()).send(message)

    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    expect(url).toBe('https://api.resend.com/emails')
    expect(init.method).toBe('POST')

    const headers = init.headers as Record<string, string>

    expect(headers.Authorization).toBe('Bearer re_test_key_123')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('тіло — JSON з from/to/subject/text, а не HTML', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await new ResendEmailSender(config()).send(message)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as Record<string, unknown>

    expect(body).toEqual({
      from: CONFIG_VALUES.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.body,
    })
    // Саме `text`, не `html` — порт §7.2 описує тіло як текстове.
    expect(body.html).toBeUndefined()
  })

  it('передає Idempotency-Key, коли deliveryId заданий', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await new ResendEmailSender(config()).send({ ...message, idempotencyKey: 'delivery-42' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>

    expect(headers['Idempotency-Key']).toBe('delivery-42')
  })

  it('не додає заголовок Idempotency-Key узагалі, коли ключа немає', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await new ResendEmailSender(config()).send(message)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>

    // Не порожній рядок і не undefined-значення — самого ключа немає в об'єкті:
    // порожній заголовок і відсутній заголовок для Resend не одне й те саме.
    expect('Idempotency-Key' in headers).toBe(false)
  })

  it('успішна відповідь нічого не кидає', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await expect(new ResendEmailSender(config()).send(message)).resolves.toBeUndefined()
  })

  it('помилку з JSON-тілом перетворює на розбірливий ResendEmailError', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, { message: 'Too many requests' }))

    await expect(new ResendEmailSender(config()).send(message)).rejects.toMatchObject({
      status: 429,
      message: 'Resend: 429 Too many requests',
    })
  })

  /**
   * Провайдер не зобов'язаний повертати JSON на кожну помилку (502 від
   * проксі, порожнє тіло тощо). `.json()` тоді падає — і це не має ламати
   * обробку чи ховати сам факт помилки за незрозумілим винятком парсера.
   */
  it('не-JSON тіло помилки не ламає обробку — падає з зрозумілим фолбеком', async () => {
    fetchMock.mockResolvedValue(errorResponse(502, new SyntaxError('Unexpected token < in JSON')))

    await expect(new ResendEmailSender(config()).send(message)).rejects.toMatchObject({
      status: 502,
      message: 'Resend: 502 відповідь без опису помилки',
    })
  })

  it('тіло помилки без message, але з name — використовує name', async () => {
    fetchMock.mockResolvedValue(errorResponse(422, { name: 'validation_error' }))

    await expect(new ResendEmailSender(config()).send(message)).rejects.toMatchObject({
      status: 422,
      message: 'Resend: 422 validation_error',
    })
  })

  /**
   * §7.3: тик диспетчера — 30с, довше чекати на одну спробу нема сенсу.
   * Реального очікування 10с тут немає — перевіряється сам факт, що виклик
   * іде з `AbortSignal`, і що скасування `fetch()` (так поводиться реальний
   * таймаут) доходить до викликача як відхилення, а не ковтається мовчки.
   */
  it('передає AbortSignal у fetch — межа часу на боці виклику, не SDK', async () => {
    fetchMock.mockResolvedValue(okResponse())

    await new ResendEmailSender(config()).send(message)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]

    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('таймаут (AbortError від fetch) доходить до викликача як відхилення', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')

    fetchMock.mockRejectedValue(abortError)

    await expect(new ResendEmailSender(config()).send(message)).rejects.toBe(abortError)
  })
})
