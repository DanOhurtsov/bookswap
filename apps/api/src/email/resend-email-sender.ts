import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EmailMessage, EmailSender } from './email-sender'

const ENDPOINT = 'https://api.resend.com/emails'

/** Довше за це чекати нема сенсу: тик диспетчера — 30 секунд (§7.3). */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Помилка провайдера з розбірливим описом.
 *
 * Саме цей рядок ляже в `NotificationDelivery.error` і саме його читатимуть, коли
 * доставка дійде до `FAILED`. «TypeError: fetch failed» там не допоміг би нікому.
 */
export class ResendEmailError extends Error {
  constructor(
    readonly status: number,
    description: string,
  ) {
    super(`Resend: ${String(status)} ${description}`)
    this.name = 'ResendEmailError'
  }
}

interface ResendErrorBody {
  message?: string
  name?: string
}

/**
 * §2 і §7.2: справжній провайдер пошти («Resend або Postmark»).
 *
 * Друга реалізація того самого порту `EmailSender` — рівно так, як обіцяв
 * коментар у `email-sender.ts`. `AuthService` про неї не знає й не змінюється:
 * підтвердження адреси, скидання пароля й сповіщення §7 їдуть одним шляхом.
 *
 * Голий `fetch` замість SDK: це один POST із JSON, а пакет `resend` приніс би
 * власний HTTP-клієнт і власну політику ретраїв — другу після тієї, що вже є в
 * диспетчері (§7.3, правило 2). Двох шарів повторів бути не має: `attempts` у
 * таблиці мусить означати саме кількість спроб.
 */
@Injectable()
export class ResendEmailSender implements EmailSender {
  private readonly logger = new Logger(ResendEmailSender.name)

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage): Promise<void> {
    // Stage 10 (10i.2, D2): листи гостьового підтвердження несуть секрет на синтетичну адресу; реальний
    // провайдер їх не отримує за жодної конфігурації (маршрут бере лише `DevEmailSender`) — це другий рубіж.
    if (message.sealed === true) {
      throw new Error(
        'Запечатаний лист гостьового підтвердження не можна надсилати реальним провайдером',
      )
    }

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.getOrThrow<string>('RESEND_API_KEY')}`,
        'Content-Type': 'application/json',
        // §7.3: якщо диспетчер покинув попередній виклик за таймаутом, а той
        // усе одно дійшов до Resend, повторна спроба з тим самим ключем
        // потрапляє у вікно дедуплікації провайдера (24 години) замість того,
        // щоб гарантовано піти вдруге.
        ...(message.idempotencyKey === undefined
          ? {}
          : { 'Idempotency-Key': message.idempotencyKey }),
      },
      // Лише `text`: порт §7.2 описує тіло як текстове, і HTML тут з'явиться
      // тоді, коли з'явиться потреба, а не «щоб було».
      body: JSON.stringify({
        from: this.config.getOrThrow<string>('EMAIL_FROM'),
        to: message.to,
        subject: message.subject,
        text: message.body,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as ResendErrorBody | undefined

      throw new ResendEmailError(
        response.status,
        body?.message ?? body?.name ?? 'відповідь без опису помилки',
      )
    }

    // Ні адреси, ні тіла в лозі: у листах підтвердження їде одноразовий токен —
    // рівно та причина, через яку `DevEmailSender` заборонений у проді.
    this.logger.debug('Лист прийнято провайдером')
  }
}
