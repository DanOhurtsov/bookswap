import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  NOTIFICATION_TYPE,
  PREFERENCE_CHANNEL,
  defaultPreferenceEnabled,
  isGuestResponseNotificationType,
  type Channel,
  type NotificationChannels,
  type NotificationPreference,
  type NotificationPreferencesResponse,
  type UpdateNotificationPreferencesRequest,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { PrismaService } from '../prisma/prisma.service'
import { TelegramConfig } from '../telegram/telegram.config'
import type { NotificationType } from '../generated/prisma/enums'

/**
 * Те, що потрібно для вирішення «куди доставляти». Читається всередині чужої
 * транзакції разом зі створенням `Notification` (§7.3, правило 1), тож тип
 * навмисно вузький — рівно дві моделі.
 */
export type PreferenceReader = Pick<PrismaService, 'notificationPreference' | 'user'>

/**
 * Чи доставка цим адресатом фізично можлива — рівно те, що для цього треба знати.
 *
 * Окремо від `RecipientChannels`: `channelsFor` працює всередині чужої транзакції
 * й не має права читати зайвого, а адреса пошти йому не потрібна — потрібен лише
 * факт її підтвердження.
 */
interface RecipientReachability {
  emailVerified: boolean
  telegramChatId: string | null
}

/** Те саме плюс сама адреса — для відповіді `GET /me/notification-preferences`. */
interface RecipientChannels extends RecipientReachability {
  email: string
}

/**
 * §7.6: матриця «тип події × канал».
 *
 * Клітинки, яких немає в базі, означають «як за замовчуванням», а не «вимкнено».
 * Політику дефолтів тримає `defaultPreferenceEnabled` зі `shared` — одна на бек і
 * фронт, бо інакше сторінка налаштувань показувала б одне, а диспетчер робив би
 * інше, і розбіжність помітили б лише за скаргою «мені не прийшов лист».
 *
 * Увімкнений перемикач — **необхідна**, але не достатня умова доставки. Друга
 * половина — чи канал взагалі може спрацювати: чи налаштований бот на сервері, чи
 * прив'язаний чат, чи підтверджена адреса. Рядок доставки, для якого ця друга
 * половина хибна, — не «спробуємо пізніше», а тиха брехня: він п'ять разів
 * невдало спробує й ляже у `FAILED`, вдаючи збій каналу.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramConfig,
  ) {}

  /**
   * Канали, у які треба створити `NotificationDelivery` для цієї події.
   *
   * Запити послідовні, а не `Promise.all`: клієнт інтерактивної транзакції Prisma
   * сидить на одному з'єднанні, і паралельні запити в ньому лише вишикувалися б
   * у чергу — зате помилка в одному з них лишила б другий без обробника.
   */
  async channelsFor(
    userId: string,
    type: NotificationType,
    client: PreferenceReader,
  ): Promise<Channel[]> {
    const recipient = await client.user.findUnique({
      where: { id: userId },
      select: { emailVerified: true, telegramChatId: true },
    })

    // Користувача видалили між переходом і записом сповіщення — далі нема кому
    // доставляти. Рядок `Notification` усе одно зникне каскадом.
    if (recipient === null) return []

    const stored = await client.notificationPreference.findMany({
      where: { userId, type },
      select: { channel: true, enabled: true },
    })

    const telegramLinked = recipient.telegramChatId !== null
    const channels: Channel[] = []

    for (const channel of PREFERENCE_CHANNEL) {
      // Stage 10 (10i.3): відповіді гостя не мають Telegram за жодним налаштуванням — навіть якщо
      // клітинка колись потрапила в базу явною (`update` таке вже відхиляє).
      if (channel === 'TELEGRAM' && isGuestResponseNotificationType(type)) continue

      const explicit = stored.find((row) => row.channel === channel)
      const enabled =
        explicit?.enabled ?? defaultPreferenceEnabled(type, channel, { telegramLinked })

      if (!enabled) continue

      // Друга половина умови — чи доставка фізично можлива. Налаштування при
      // цьому зберігається як було: людина, яка ввімкнула Telegram і тимчасово
      // відв'язала чат, після повторного підключення має побачити свій вибір.
      if (!this.deliverable(channel, recipient)) continue

      channels.push(channel)
    }

    return channels
  }

  /** §8: `GET /me/notification-preferences`. */
  async get(userId: string): Promise<NotificationPreferencesResponse> {
    const recipient = await this.recipient(userId)
    const stored = await this.prisma.notificationPreference.findMany({
      where: { userId },
      select: { type: true, channel: true, enabled: true },
    })

    return { preferences: expand(stored, recipient), channels: this.channelsOf(recipient) }
  }

  /**
   * §8: `PUT /me/notification-preferences`.
   *
   * Надіслані клітинки записуються, ненадіслані лишаються як були (див. контракт
   * у `shared`). Відповідь — уся матриця, а не збережений шматок: клієнт має
   * побачити підсумковий стан, не домальовуючи його з дефолтів у себе.
   *
   * Увімкнути `TELEGRAM` без прив'язки чату не можна: це тиха обіцянка, якої
   * система не виконає, і UI має повести людину до кнопки «Підключити», а не
   * показати «збережено». Непідтверджена пошта, навпаки, зберігається: адресу
   * підтверджують тим самим листом, і забороняти вибір наперед було б колом.
   */
  async update(
    userId: string,
    request: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferencesResponse> {
    const recipient = await this.recipient(userId)

    // Stage 10 (10i.3): Telegram для відповідей гостя не існує — краще чесна відмова, ніж збережений
    // перемикач, який нічого не робить. EMAIL — звичайна клітинка.
    if (
      request.preferences.some(
        (row) =>
          row.enabled && row.channel === 'TELEGRAM' && isGuestResponseNotificationType(row.type),
      )
    ) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Сповіщення про відповіді гостя не надсилаються в Telegram: вмикати його для них не можна',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (
      request.preferences.some((row) => row.channel === 'TELEGRAM' && row.enabled) &&
      !this.deliverable('TELEGRAM', recipient)
    ) {
      throw new ApiException(
        API_ERROR_CODES.TELEGRAM_NOT_LINKED,
        this.telegram.configured
          ? 'Спершу підключіть Telegram — інакше надсилати нема куди'
          : 'Telegram-бот не налаштований на цьому сервері',
        HttpStatus.CONFLICT,
      )
    }

    // Транзакція, щоб матриця не лишилася наполовину збереженою: сторінка
    // надсилає рядки, які людина бачила як одне ціле.
    await this.prisma.$transaction(
      request.preferences.map((row) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_type_channel: { userId, type: row.type, channel: row.channel } },
          create: { userId, type: row.type, channel: row.channel, enabled: row.enabled },
          update: { enabled: row.enabled },
        }),
      ),
    )

    return await this.get(userId)
  }

  /**
   * Чи доставка цим каналом фізично можлива для цього адресата **зараз**.
   *
   * `IN_APP` можливий завжди: рядок `Notification` уже в базі, і показати його
   * нема чому завадити.
   */
  private deliverable(channel: Channel, recipient: RecipientReachability): boolean {
    if (channel === 'EMAIL') return recipient.emailVerified
    if (channel === 'TELEGRAM') {
      return this.telegram.configured && recipient.telegramChatId !== null
    }

    return true
  }

  private channelsOf(recipient: RecipientChannels): NotificationChannels {
    const telegramConnected = recipient.telegramChatId !== null

    return {
      inApp: { configured: true, connected: true, available: true },
      email: {
        address: recipient.email,
        verified: recipient.emailVerified,
        // Пошта налаштована на сервері завжди: провайдер або dev, або справжній,
        // але порт існує в обох випадках (§7.2).
        configured: true,
        connected: recipient.emailVerified,
        available: recipient.emailVerified,
      },
      telegram: {
        configured: this.telegram.configured,
        connected: telegramConnected,
        available: this.telegram.configured && telegramConnected,
      },
    }
  }

  private async recipient(userId: string): Promise<RecipientChannels> {
    // Маршрут за `SessionGuard`, тож користувач існує; `findUniqueOrThrow` тут —
    // не перевірка прав, а відмова працювати з порожнечею.
    return await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerified: true, telegramChatId: true },
    })
  }
}

interface StoredPreference {
  type: NotificationType
  channel: Channel
  enabled: boolean
}

/**
 * Розрідженого набору рядків → повна матриця.
 *
 * Порядок фіксований (`NOTIFICATION_TYPE` × `PREFERENCE_CHANNEL`), щоб відповідь
 * не залежала від того, які клітинки користувач чіпав і в якому порядку їх віддала
 * база: інакше кожне збереження перетасовувало б рядки таблиці на сторінці.
 *
 * Матриця описує **вибір людини**, а не можливість доставки: непідтверджена
 * пошта не перетворює ввімкнену клітинку на вимкнену. Чи доставка справді
 * відбудеться, каже `channels` поруч — і саме цю різницю UI показує окремо.
 */
function expand(
  stored: readonly StoredPreference[],
  recipient: RecipientChannels,
): NotificationPreference[] {
  const telegramLinked = recipient.telegramChatId !== null
  const byCell = new Map(stored.map((row) => [`${row.type}:${row.channel}`, row.enabled]))
  const matrix: NotificationPreference[] = []

  for (const type of NOTIFICATION_TYPE) {
    for (const channel of PREFERENCE_CHANNEL) {
      matrix.push({
        type,
        channel,
        enabled:
          byCell.get(`${type}:${channel}`) ??
          defaultPreferenceEnabled(type, channel, { telegramLinked }),
      })
    }
  }

  return matrix
}
