import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { notificationPayloadSchema, type Channel } from '@bookswap/shared'
import { BACKGROUND_MODE, type BackgroundMode } from '../common/background'
import { PrismaService } from '../prisma/prisma.service'
import { NOTIFICATION_CHANNELS } from './channels/notification-channel'
import { isTerminalFailure, nextAttemptAfterFailure } from './delivery-backoff'
import { renderNotification } from './notification-renderer'
import {
  DELIVERY_ATTEMPT_TIMEOUT_MS,
  DELIVERY_LEASE_MS,
  DISPATCH_BATCH_SIZE,
  DISPATCH_INTERVAL_MS,
  MAX_DELIVERY_ATTEMPTS,
} from './notifications.constants'
import type {
  DeliveryRecipient,
  NotificationChannelSender,
  RenderedNotification,
} from './channels/notification-channel'

/** Рядок, який повертає захоплювальний `UPDATE … RETURNING`. */
interface ClaimedDelivery {
  id: string
  notificationId: string
  channel: Channel
  attempts: number
  /** Fencing-токен цієї конкретної оренди. Без нього результат записувати не можна. */
  leaseToken: string
}

/** Подія + адресат + готовий текст. */
interface DeliveryJob {
  recipient: DeliveryRecipient
  message: RenderedNotification
}

/**
 * §7.3, правило 2: воркер доставки.
 *
 * Черга — таблиця `NotificationDelivery`, а не Redis/BullMQ: §2 виключає Redis зі
 * стека v1, і на десятках користувачів таблиця робить те саме, не додаючи
 * інфраструктури, яку треба піднімати, моніторити й бекапити.
 *
 * Чотири властивості, заради яких усе написано саме так — і одна межа, яку
 * важливо не переплутати з гарантією:
 *
 * 1. **БАЗА ніколи не показує подвійний результат — навіть після протухлої
 *    оренди.** Захоплення й запис результату — різні моменти часу, і між ними
 *    рядок може забрати інший процес. Тому захоплення виписує fencing-токен, а
 *    фінальний `UPDATE` іде з умовою `WHERE "leaseToken" = <мій>`: воркер, який
 *    «прокинувся» після протухлої оренди, нічого не перезапише. Без цього
 *    свіжий `SENT` перетворився б на старий `PENDING`, і рядок пішов би на
 *    повторну відправку, поки перша ще, можливо, триває.
 * 2. **Довгий `load()` не дає застарілому воркеру почати зовнішній виклик.**
 *    Безпосередньо перед `send()` воркер атомарно звіряє `PENDING`, свій
 *    fencing-токен, номер спроби й ще чинну оренду та продовжує її. Якщо за час
 *    читання контексту рядок протух або його вже перехопили, провайдер узагалі
 *    не викликається. Продовжена оренда дає запас для обмеженого таймаутом
 *    `send()`, але фінальний запис однаково fenced: ні `load()`, ні запис у БД
 *    не оголошуються такими, що гарантовано вкладаються в 60 секунд.
 * 3. **Падіння процесу не губить рядок і не переганяє лічильник.** `attempts`
 *    інкрементується при захопленні, тож воркер, що помер посеред виклику, лишає
 *    рядок у `PENDING` з відкладеною спробою. Захоплення бере лише рядки з
 *    `attempts < 5`, а ті, що вичерпали ліміт і лишилися без живої оренди,
 *    добиває `reap()` — інакше вони висіли б у `PENDING` вічно.
 * 4. **Канали незалежні.** Кожен рядок — окрема доставка з власним лічильником,
 *    тож невдалий Telegram не робить нічого з листом, який дійшов (§4.8).
 *
 * **Межа з провайдером — at-least-once, не exactly-once.** `withTimeout`
 * (`Promise.race`) перестає ЧЕКАТИ на `send()`, коли той висить довше за
 * таймаут, але не СКАСОВУЄ сам мережевий виклик — Node цього не вміє для
 * довільного провайдерського коду. Тобто рядок, чия оренда протухла через
 * таймаут, а не крах процесу, може бути ДІЙСНО надісланий провайдером двічі:
 * раз тим викликом, що зрештою (пізно) завершується успішно, і раз тим, що
 * забрав рядок після протухлої оренди. Fencing гарантує, що для ДВОХ ЗДОРОВИХ
 * воркерів із чинними орендами провайдер побачить рівно один виклик; після
 * таймауту чи краху процесу гарантія слабша — БД зафіксує рівно один
 * результат, але зовнішній виклик міг статися двічі. `deliveryId`,
 * прокинутий у `NotificationChannelSender.send()`, дає каналам, чий провайдер
 * підтримує ключ ідемпотентності (Resend), шанс і на цій межі не подвоїти
 * доставку — `notification-delivery-lease.e2e-spec.ts` звіряє це прямо,
 * рахуючи реальні виклики фейкового відправника, а не лише фінальний рядок у
 * БД.
 */
@Injectable()
export class NotificationDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDispatcher.name)
  private readonly senders: Map<Channel, NotificationChannelSender>
  private timer: NodeJS.Timeout | undefined
  /** Тик у процесі. Захищає від накладання тиків, а не від інших процесів — за це відповідає БД. */
  private running = false
  /** Поштовх, що прийшов під час тику: прокрутити ще раз, щойно звільниться. */
  private pending = false
  /** Застосунок зупиняється — нових кіл не починаємо. */
  private stopping = false
  /**
   * Активний тик **разом із запланованими продовженнями**.
   *
   * `wake()` навмисно нічого не чекає (дія користувача вже успішна), тож без
   * цього поля тик, запущений мілісекунду тому, лишався б виконуватися на вже
   * від'єднаному Prisma-клієнті. Продовження за `pending` живе всередині циклу в
   * `run()`, а не окремим викликом, — саме щоб одна ця обіцянка покривала й його:
   * інакше `onModuleDestroy` дочекався б першого кола й пішов, поки друге працює.
   */
  private inFlight: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_CHANNELS) channels: readonly NotificationChannelSender[],
    /**
     * Замовчування діє ЛИШЕ для ручного `new` (тести будують «другий процес»
     * саме так) — Nest завжди передає значення з провайдера, а якщо той зникне
     * з модуля, DI впаде голосно, а не тихо підставить `'enabled'`.
     */
    @Inject(BACKGROUND_MODE) private readonly background: BackgroundMode = 'enabled',
  ) {
    this.senders = new Map(channels.map((sender) => [sender.channel, sender]))
  }

  onModuleInit(): void {
    // Вимкнений режим не заводить таймера взагалі, а не лишає його тикати в
    // порожній `trigger()`: тридцять п'ять e2e-файлів дали б тридцять п'ять
    // таймерів, які нічого не роблять, зате з'являються в кожному дампі.
    if (this.background === 'disabled') return

    // НЕ `this.inFlight = this.run()`: якщо тик, запущений попереднім тиком
    // таймера, ще працює, прямий виклик перезаписав би `inFlight` щойно
    // отриманою — уже виконаною — обіцянкою від `run()`'s раннього виходу
    // («я вже working, `pending=true`, повертаю 0»), а не обіцянкою активної
    // роботи. `onModuleDestroy` тоді чекав би не те: побачив би «завершено»
    // за мілісекунди, поки справжній тик ще тримає відкрите з'єднання. Через
    // `trigger()` interval лише сигналізує — фактичний `inFlight` лишається
    // прив'язаним до того виклику `run()`, який справді працює.
    this.timer = setInterval(() => {
      this.trigger()
    }, DISPATCH_INTERVAL_MS)

    // Без unref() таймер тримає процес живим — і `jest` після e2e не завершується.
    this.timer.unref()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true

    if (this.timer !== undefined) clearInterval(this.timer)

    // Дочекатися тику, який уже почався: він тримає з'єднання, яке ось-ось
    // закриють. `run()` не кидає, тож і чекати на нього безпечно. Оскільки
    // `inFlight` завжди вказує на СПРАВЖНІЙ активний виклик (гарантія
    // `trigger()`), це чекання ніколи не «проскакує» повз роботу, що триває.
    await this.inFlight
  }

  /**
   * Поштовх після коміту (§7.3). Не чекає завершення й нічого не кидає: дія
   * користувача вже успішна, і невдалий тик не має права це змінити.
   */
  wake(): void {
    this.trigger()
  }

  /**
   * Єдина крапка, звідки стартує новий прохід — і для інтервалу, і для `wake()`.
   *
   * Правило одне: `this.inFlight` присвоюється **лише** тоді, коли справді
   * запускається новий `run()`. Якщо прохід уже триває, `trigger()` виставляє
   * `pending` (внутрішній цикл `run()` підхопить його сам) і не займає
   * `inFlight` — інакше друге посилання на «майже миттєвий» результат
   * раннього виходу з `run()` затерло б посилання на той `run()`, що й досі
   * працює, і `onModuleDestroy` чекав би не на нього.
   */
  private trigger(): void {
    // Єдина крапка входу — тому вимикач стоїть саме тут: разом з інтервалом він
    // закриває і `wake()` (§7.3, поштовх після коміту), тобто другий, незалежний
    // від розкладу шлях, яким прохід стартував би посеред чужого e2e-файлу.
    // Публічний `run()` цього не бачить і лишається повністю робочим: тест, якому
    // прохід потрібен по суті, кличе його явно.
    if (this.background === 'disabled') return

    if (this.stopping) return

    if (this.running) {
      this.pending = true

      return
    }

    this.inFlight = this.run()
  }

  /**
   * Прохід черги: тикає, поки під час тику приходять поштовхи.
   *
   * Публічний і з керованим `now`, щоб тести не чекали 30 секунд — той самий
   * прийом, що в `SessionCleanupService.run()`.
   *
   * `running` тут не заміна блокуванню в БД, а економія: два тики в одному процесі
   * все одно не надіслали б двічі (`SKIP LOCKED` і fencing це не дозволять), але
   * дарма сходили б у базу.
   */
  async run(now = new Date()): Promise<number> {
    if (this.running) {
      this.pending = true

      return 0
    }

    this.running = true

    let total = 0

    try {
      do {
        this.pending = false
        total += await this.tick(now)
      } while (this.pending && !this.stopping)
    } catch (error) {
      // Помилка тику не має валити застосунок: наступний спробує знову.
      this.logger.error('Тик диспетчера впав', error)
    } finally {
      this.running = false
    }

    return total
  }

  /**
   * Один прохід: спершу прибрати мертве, потім по одному рядку за раз.
   *
   * Партія обмежена `DISPATCH_BATCH_SIZE`, але рядки беруться поштучно — кожен
   * зі своєю орендою, що починається безпосередньо перед його ж спробою.
   */
  private async tick(now: Date): Promise<number> {
    await this.reap(now)

    let sent = 0

    for (let taken = 0; taken < DISPATCH_BATCH_SIZE; taken += 1) {
      if (this.stopping) break

      const delivery = await this.claim(new Date())

      if (delivery === undefined) break
      if (await this.deliver(delivery)) sent += 1
    }

    return sent
  }

  /**
   * §7.3: «забирає `NotificationDelivery` зі `status = PENDING AND nextAttemptAt <= now()`».
   *
   * Один запит замість «прочитати → надіслати → оновити»: між читанням і
   * оновленням той самий рядок устиг би прочитати другий воркер, і лист пішов би
   * двічі. `FOR UPDATE SKIP LOCKED` у підзапиті — це те, що перетворює таблицю на
   * чергу: конкурент не стає в чергу за локом, а бере наступний вільний рядок.
   *
   * `attempts < MAX` у фільтрі — не косметика: без нього рядок, покинутий
   * процесом на п'ятій спробі, отримав би шосту.
   *
   * Сирий SQL, бо ні `SKIP LOCKED`, ні `UPDATE … RETURNING` Prisma не виражає.
   */
  private async claim(now: Date): Promise<ClaimedDelivery | undefined> {
    const leaseToken = randomUUID()
    const leaseUntil = new Date(now.getTime() + DELIVERY_LEASE_MS)

    // `nextAttemptAt` відсувається разом з орендою: він — те, що бачать старіші
    // читачі черги, і поки оренда жива, рядок не має бути «дозрілим».
    const [claimed] = await this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE "NotificationDelivery" AS d
      SET "attempts" = d."attempts" + 1,
          "leaseToken" = ${leaseToken},
          "leaseUntil" = ${leaseUntil},
          "nextAttemptAt" = ${leaseUntil}
      FROM (
        SELECT "id"
        FROM "NotificationDelivery"
        WHERE "status" = 'PENDING'
          AND "nextAttemptAt" <= ${now}
          AND "attempts" < ${MAX_DELIVERY_ATTEMPTS}
        ORDER BY "nextAttemptAt"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      ) AS candidate
      WHERE d."id" = candidate."id"
      RETURNING d."id", d."notificationId", d."channel", d."attempts", d."leaseToken"
    `

    return claimed
  }

  /**
   * Добиває рядки, які вичерпали ліміт спроб, але лишилися `PENDING`.
   *
   * Так виглядає воркер, що помер між захопленням і записом результату на п'ятій
   * спробі: `attempts = 5`, статус `PENDING`, оренда протухла. Захоплення такий
   * рядок більше не візьме (`attempts < 5`), тож без цього кроку він висів би в
   * черзі вічно, вдаючи роботу, якої ніхто не робить.
   *
   * Умова на оренду обов'язкова: інакше цей запит забрав би рядок у воркера, який
   * саме зараз робить свою п'яту спробу.
   *
   * **Один `UPDATE … RETURNING`, а не «прочитати → оновити за id».** Розділені
   * `findMany` + `updateMany` лишали вікно між читанням і записом: рядок, який
   * `findMany` побачив як покинутий (`PENDING`, оренда протухла), міг за цю
   * мить дописати «пізній» воркер — той, чия мережева відповідь усе-таки
   * (пізно) прийшла й пройшла fencing у `finish()` (`leaseToken` там ще
   * збігався в момент читання). `updateMany` за самим лише `id` не бачить
   * різниці й безумовно перезаписав би щойно записаний `SENT` на `FAILED`.
   * Один `UPDATE` з тими самими умовами (`status = 'PENDING' AND attempts >=
   * MAX AND оренда протухла`) у `WHERE` не має цього вікна: Postgres бере
   * рядковий лок під час виконання самого `UPDATE`, і якщо рядок у цю мить
   * редагує чужа незакомічена транзакція, наш `UPDATE` **чекає** на неї
   * (EvalPlanQual), а не читає застарілий знімок. Щойно та комітиться,
   * `WHERE` перевіряється заново на вже оновлених даних: якщо рядок більше не
   * `PENDING`, він просто не потрапляє у `RETURNING` — SKIP LOCKED тут
   * навмисно НЕ використовується, бо «пропустити» дало б той самий результат
   * лише випадково, а «почекати й перевірити ще раз» — за конструкцією.
   * Детермінований доказ цього — `notification-delivery-lease.e2e-spec.ts`:
   * барʼєр на `pg_stat_activity` ловить `reap()` саме в стані очікування на
   * цьому локу.
   *
   * §11: «кожна доставка» логується окремо — `deliveryId`, `channel`, `status`,
   * `attempts`. Один агрегований рядок лога («покинуто: N») не дає відповісти на
   * «котра саме» під час розслідування, тож логуються лише рядки, які РЕАЛЬНО
   * повернув `RETURNING` — а не все, що спершу здавалося кандидатом.
   */
  private async reap(now: Date): Promise<void> {
    const error = 'Спроби вичерпано; остання не завершилася — процес перервано'

    const reaped = await this.prisma.$queryRaw<
      Array<Pick<ClaimedDelivery, 'id' | 'notificationId' | 'channel' | 'attempts'>>
    >`
      UPDATE "NotificationDelivery"
      SET "status" = 'FAILED',
          "error" = ${error},
          "leaseToken" = NULL,
          "leaseUntil" = NULL
      WHERE "status" = 'PENDING'
        AND "attempts" >= ${MAX_DELIVERY_ATTEMPTS}
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
      RETURNING "id", "notificationId", "channel", "attempts"
    `

    for (const delivery of reaped) {
      this.log(delivery, 'FAILED', error)
    }
  }

  /**
   * Дочитує все, що потрібно для тексту одного рядка.
   *
   * Читання поштучне, бо й захоплення поштучне. На масштабі §1 (десятки
   * користувачів) різниця в кількості запитів нічого не означає, а плата за
   * пачкове захоплення — некоректна оренда — значить дуже багато.
   */
  private async load(delivery: ClaimedDelivery): Promise<DeliveryJob | undefined> {
    const notification = await this.prisma.notification.findUnique({
      where: { id: delivery.notificationId },
      select: {
        id: true,
        type: true,
        payload: true,
        user: { select: { id: true, email: true, emailVerified: true, telegramChatId: true } },
      },
    })

    if (notification === null) return undefined

    const parsed = notificationPayloadSchema.safeParse(notification.payload)
    const payload = parsed.success ? parsed.data : {}

    const actor =
      payload.actorId === undefined
        ? null
        : await this.prisma.user.findUnique({
            where: { id: payload.actorId },
            select: { displayName: true },
          })

    const copy =
      payload.copyId === undefined
        ? null
        : await this.prisma.copy.findUnique({
            where: { id: payload.copyId },
            select: { edition: { select: { work: { select: { title: true } } } } },
          })

    return {
      recipient: {
        userId: notification.user.id,
        email: notification.user.email,
        emailVerified: notification.user.emailVerified,
        telegramChatId: notification.user.telegramChatId,
      },
      message: renderNotification(
        {
          type: notification.type,
          payload,
          actorName: actor?.displayName ?? null,
          bookTitle: copy?.edition.work.title ?? null,
          webOrigin: this.config.getOrThrow<string>('WEB_ORIGIN'),
        },
        delivery.channel,
      ),
    }
  }

  /** Одна доставка. `true`, якщо дійшла. §11 вимагає логувати кожну. */
  private async deliver(delivery: ClaimedDelivery): Promise<boolean> {
    const sender = this.senders.get(delivery.channel)

    if (sender === undefined) {
      // Канал є в базі, а реалізації немає: рядок лишився від старішої версії
      // коду. Ретраї тут безглузді — реалізація сама не з'явиться.
      await this.finish(delivery, { failure: `Канал ${delivery.channel} не має реалізації` })

      return false
    }

    let job: DeliveryJob | undefined

    try {
      job = await this.load(delivery)
    } catch (error) {
      // Читання контексту впало — рядок не має лишитися з живою орендою до її
      // кінця, інакше кожен збій бази коштує хвилини затримки.
      await this.finish(delivery, { failure: describe(error) })

      return false
    }

    if (job === undefined) {
      // Сповіщення зникло між захопленням і читанням — тільки разом із
      // користувачем (каскад §4.8). Надсилати нема кому й нема що; ретраї теж
      // безглузді, тож це термінальний випадок незалежно від лічильника.
      await this.finish(delivery, { failure: 'Сповіщення зникло до відправки', terminal: true })

      return false
    }

    // `load()` ходить по кількох таблицях і не має власної часової стелі. За цей
    // час початкова оренда могла протухнути, а рядок — законно перейти іншому
    // воркеру. Перевірка мусить бути ОДНІЄЮ умовною операцією безпосередньо перед
    // зовнішнім ефектом: окреме «прочитати leaseUntil → update» лишило б те саме
    // вікно між перевіркою та продовженням.
    if (!(await this.renewBeforeSend(delivery))) return false

    try {
      await withTimeout(
        sender.send(job.recipient, job.message, delivery.id),
        DELIVERY_ATTEMPT_TIMEOUT_MS,
        `Канал ${delivery.channel} не відповів за ${String(DELIVERY_ATTEMPT_TIMEOUT_MS)} мс`,
      )
    } catch (error) {
      await this.finish(delivery, { failure: describe(error) })

      return false
    }

    return await this.finish(delivery, { failure: null })
  }

  /**
   * Останній fence перед межею, яку база вже не контролює.
   *
   * Умови навмисно повторюють усю ідентичність спроби, а не лише токен:
   * `PENDING` захищає від уже завершеного рядка, `attempts` — від іншої спроби,
   * `leaseToken` — від іншого воркера, `leaseUntil > clock_timestamp()` — від
   * власної вже протухлої оренди. `UPDATE … RETURNING` перевіряє їх і продовжує
   * оренду атомарно; `nextAttemptAt` рухається разом із нею, бо саме це поле
   * читає `claim()`.
   */
  private async renewBeforeSend(delivery: ClaimedDelivery): Promise<boolean> {
    const renewed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH lease_clock AS (
        SELECT clock_timestamp() AS now
      )
      UPDATE "NotificationDelivery" AS d
      SET "leaseUntil" = lease_clock.now + ${DELIVERY_LEASE_MS} * INTERVAL '1 millisecond',
          "nextAttemptAt" = lease_clock.now + ${DELIVERY_LEASE_MS} * INTERVAL '1 millisecond'
      FROM lease_clock
      WHERE d."id" = ${delivery.id}
        AND d."status" = 'PENDING'
        AND d."leaseToken" = ${delivery.leaseToken}
        AND d."attempts" = ${delivery.attempts}
        AND d."leaseUntil" > lease_clock.now
      RETURNING d."id"
    `

    if (renewed.length > 0) return true

    this.log(
      delivery,
      'LEASE_LOST',
      'оренда протухла або спробу вже перехоплено до початку зовнішньої відправки',
    )

    return false
  }

  /**
   * Записує результат спроби — **тільки якщо оренда все ще наша**.
   *
   * `WHERE leaseToken = <мій>` і є fencing: воркер, чия оренда протухла й рядок
   * уже забрав інший, отримає `count = 0` і мовчки відступить. Інакше він затер
   * би чужий свіжий результат своїм застарілим — і `SENT` перетворився б на
   * `PENDING` із поверненням у чергу.
   *
   * Момент завершення береться тут, а не на початку тику: `sentAt` мусить казати,
   * коли лист справді пішов, а `nextAttemptAt` — відлічувати паузу від кінця
   * невдалої спроби, а не від моменту, коли диспетчер лише прокинувся.
   */
  private async finish(
    delivery: ClaimedDelivery,
    outcome: { failure: string | null; terminal?: boolean },
  ): Promise<boolean> {
    const completedAt = new Date()
    const { failure } = outcome
    const terminal = outcome.terminal === true || isTerminalFailure(delivery.attempts)

    const data =
      failure === null
        ? {
            status: 'SENT' as const,
            sentAt: completedAt,
            error: null,
            leaseToken: null,
            leaseUntil: null,
          }
        : {
            // Текст помилки обрізається: `error` читає людина в базі, а не парсер,
            // і стектрейс на кілобайт тут нічого не додає.
            error: failure.slice(0, 500),
            leaseToken: null,
            leaseUntil: null,
            ...(terminal
              ? { status: 'FAILED' as const }
              : { nextAttemptAt: nextAttemptAfterFailure(completedAt, delivery.attempts) }),
          }

    const { count } = await this.prisma.notificationDelivery.updateMany({
      where: { id: delivery.id, leaseToken: delivery.leaseToken },
      data,
    })

    if (count === 0) {
      // Рядок або зник разом із користувачем (каскад §4.8), або його вже забрав
      // інший воркер. Обидва випадки — не помилка цього процесу, але мовчати про
      // них не можна: другий означає, що оренда виявилася замалою.
      //
      // §11 вимагає всі чотири поля навіть тут, не лише в успішному записі:
      // `deliveryId`, `channel` і `attempts` несе сам `log()`, а замість
      // `status` — те, ЧИМ би цей запис став, якби оренда була наша
      // (`SENT`/`FAILED`/`PENDING`), інакше з лога зникає відповідь на
      // найважливіше в розслідуванні питання: що саме застарілий воркер
      // намагався (і не зміг) записати.
      const attempted = failure === null ? 'SENT' : terminal ? 'FAILED' : 'PENDING'

      this.log(
        delivery,
        'LEASE_LOST',
        `оренда вже не наша — застарілий результат спроби (був би ${attempted}) не записано`,
      )

      return false
    }

    this.log(delivery, failure === null ? 'SENT' : terminal ? 'FAILED' : 'PENDING', failure)

    return failure === null
  }

  /** §11: «Кожна доставка: `deliveryId`, `channel`, `status`, `attempts`». */
  private log(
    delivery: Pick<ClaimedDelivery, 'id' | 'channel' | 'attempts'>,
    status: string,
    error?: string | null,
  ): void {
    const line =
      `Доставка ${delivery.id}: канал ${delivery.channel}, статус ${status}, ` +
      `спроба ${String(delivery.attempts)}` +
      (error === undefined || error === null ? '' : ` — ${error}`)

    if (status === 'FAILED') this.logger.error(line)
    else if (error === undefined || error === null) this.logger.log(line)
    else this.logger.warn(line)
  }
}

/**
 * Стеля тривалості спроби — на боці диспетчера, а не каналу.
 *
 * Після атомарного pre-send renew вона обмежує час, протягом якого диспетчер
 * чекає на провайдера. Вона не доводить, що початкова оренда покриває `load()`
 * або що довільний мережевий виклик справді скасовано: `Promise.race` лише
 * перестає його чекати, тому межа з провайдером лишається at-least-once.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Повідомлення помилки без стектрейса: воно піде в колонку `error`. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`

  return String(error)
}
