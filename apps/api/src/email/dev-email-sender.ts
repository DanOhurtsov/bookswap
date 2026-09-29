import { createHash } from 'node:crypto'
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { EmailMessage, EmailSender } from './email-sender'

/** Скільки останніх листів тримати в пам'яті. Обмежено, щоб це не стало витоком. */
const OUTBOX_LIMIT = 50

const PRODUCTION = 'production'

/** Запечатаний лист (10i.2): адреса — лише як геш, щоб її не було ні в пам'яті, ні в лозі. */
export interface SealedEmail {
  subject: string
  body: string
}

const addressKey = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex')

/**
 * Причина, чому цю реалізацію не можна пускати в прод, — не «вона несправжня», а
 * дві конкретні речі:
 *
 * 1. Вона **нічого не надсилає**. У проді це означає, що підтвердження пошти й
 *    скидання пароля мовчки не працюють, і дізнаються про це з тікетів.
 * 2. Вона **друкує тіло листа в лог і тримає його в пам'яті**, а в тілі —
 *    одноразовий токен. Той, хто має доступ до логів, отримує можливість
 *    скинути будь-який пароль.
 *
 * Тому відмова спрацьовує на старті застосунку, а не на першому надсиланні:
 * краще впертися в помилку деплою, ніж дізнатися про це від користувача. Але
 * стоїть вона не в конструкторі, а в `env.validation.ts` — `NODE_ENV=production`
 * там вимагає `EMAIL_PROVIDER=resend`. Причина в тому, що з появою другого
 * провайдера (§7.2) сам факт існування цього об'єкта перестав означати його
 * використання: у проді він створюється як звичайний провайдер контейнера, поряд
 * із `ResendEmailSender`, і падати від цього не має. Значення має тільки те, чи
 * його **обрали**, а це питання конфігурації.
 *
 * Перевірка нижче лишається як другий рубіж: вона ловить екземпляр, створений
 * повз контейнер, і оточення, підмінене після старту.
 */
export class DevEmailSenderInProductionError extends Error {
  constructor() {
    super(
      'DevEmailSender не можна використовувати з NODE_ENV=production: він нічого не ' +
        'надсилає, а тіло листа з одноразовим токеном пише в лог. ' +
        'Підключи справжнього провайдера (§7.2) як реалізацію EmailSender.',
    )
    this.name = 'DevEmailSenderInProductionError'
  }
}

/** Готова відмова або `undefined`. Одна умова на два способи її повідомити. */
function productionRefusal(
  nodeEnv: string | undefined,
): DevEmailSenderInProductionError | undefined {
  return nodeEnv === PRODUCTION ? new DevEmailSenderInProductionError() : undefined
}

/** Виділено окремо, щоб перевірку можна було протестувати без DI-контейнера. */
export function assertNotProduction(nodeEnv: string | undefined): void {
  const refusal = productionRefusal(nodeEnv)

  if (refusal !== undefined) throw refusal
}

/**
 * Dev-реалізація: нічого назовні не надсилає.
 *
 * Пише лист у лог — це єдиний спосіб дістати посилання з підтвердженням, поки
 * реального провайдера немає, — і тримає останні листи в пам'яті. Пам'ять тут не
 * милиця для тестів, а те, що робить локальний флоу проходимим: e2e дістає з
 * outbox токен рівно так само, як розробник виколупує його з логу.
 *
 * Процес перезапустився — outbox порожній. Так і має бути: це не сховище.
 */
@Injectable()
export class DevEmailSender implements EmailSender {
  private readonly logger = new Logger(DevEmailSender.name)
  private readonly sent: EmailMessage[] = []
  private readonly sealed: { key: string; email: SealedEmail }[] = []

  constructor(private readonly config: ConfigService) {}

  send(message: EmailMessage): Promise<void> {
    // Звичайний випадок — неправильна конфігурація — ловиться на старті, у
    // `env.validation.ts`. Ця перевірка страхує від екземпляра, створеного повз
    // контейнер, і від оточення, підміненого після старту.
    //
    // Саме reject, а не throw: метод обіцяє Promise, і викликач із `.catch()`
    // синхронного винятку не побачив би.
    const refusal = productionRefusal(this.nodeEnv)

    if (refusal !== undefined) return Promise.reject(refusal)

    // Stage 10 (10i.2): запечатаний лист — секрет (токен/код) не друкується в лог узагалі, а адреса не
    // зберігається відкритою. Єдиний спосіб дістати лист — `sealedTo` (тест), а не читання логів.
    if (message.sealed === true) {
      this.sealed.push({
        key: addressKey(message.to),
        email: { subject: message.subject, body: message.body },
      })

      if (this.sealed.length > OUTBOX_LIMIT) this.sealed.shift()

      this.logger.log(
        'Лист (dev, нікуди не відправлено, запечатаний) → [приховано]; тіло приховано',
      )

      return Promise.resolve()
    }

    // Stage 10 (10g, Q4): гостьове запрошення. Сирий email існує лише всередині цього
    // виклику й ніде його не переживає — ні в БД (не тут узагалі), ні в outbox нижче.
    // Лог — виняток, і свідомий: без нього посилання не можна пройти вручну (немає
    // API-поля з токеном — саме так задумано, §0.8 execution plan). Тому тіло
    // друкується цілком (у ньому лише ім'я запрошувача й посилання — жодного alias чи
    // назви книжки, §6.4), а адресат замінюється на «[приховано]» — той самий рівень
    // приватності, що й для звичайного листа, мінус сама адреса.
    if (message.redactRecipient === true) {
      this.logger.log(
        `Лист (dev, нікуди не відправлено, гостьове запрошення) → [приховано]\n` +
          `Тема: ${message.subject}\n${message.body}`,
      )

      return Promise.resolve()
    }

    this.sent.push(message)

    if (this.sent.length > OUTBOX_LIMIT) this.sent.shift()

    // Тіло друкується цілком і на рівні `log`, а не `debug`: у ньому посилання з
    // одноразовим токеном, і воно — єдиний спосіб пройти флоу локально. Сховати
    // його за рівнем, який за замовчуванням вимкнений, означало б зробити
    // підтвердження пошти непрохідним на свіжому клоні. У проді цей рядок
    // недосяжний — див. assertNotProduction вище.
    this.logger.log(
      `Лист (dev, нікуди не відправлено) → ${message.to}\n` +
        `Тема: ${message.subject}\n${message.body}`,
    )

    return Promise.resolve()
  }

  /** Копія, а не внутрішній масив: викликач не має можливості його правити. */
  get outbox(): readonly EmailMessage[] {
    return [...this.sent]
  }

  lastTo(email: string): EmailMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === email)
  }

  /**
   * Stage 10 (10i.2): останній запечатаний лист для адреси (синтетичної). Копія, не внутрішній об'єкт.
   * Тестовий доступ — у проді `send()` відмовляє, тож сховище там порожнє.
   */
  sealedTo(email: string): SealedEmail | undefined {
    const key = addressKey(email)
    const found = [...this.sealed].reverse().find((entry) => entry.key === key)

    return found === undefined ? undefined : { ...found.email }
  }

  clear(): void {
    this.sent.length = 0
    this.sealed.length = 0
  }

  /**
   * Значення береться з `ConfigService`, бо саме воно провалідоване на старті
   * (`env.validation.ts`) і є для застосунку джерелом правди про середовище.
   * Запасний варіант — сирий `process.env`: якщо конфіг чомусь не заповнений,
   * перевірка має спрацювати, а не мовчки пропустити.
   */
  private get nodeEnv(): string | undefined {
    return this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV
  }
}
