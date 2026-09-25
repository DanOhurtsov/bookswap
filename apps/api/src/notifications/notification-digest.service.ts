import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { BACKGROUND_MODE, type BackgroundMode } from '../common/background'
import { isUniqueViolationOn } from '../common/prisma-errors'
import { PrismaService } from '../prisma/prisma.service'
import { NotificationsService } from './notifications.service'
import { DIGEST_INTERVAL_MS, DUE_SOON_WINDOW_DAYS } from './notifications.constants'
import { Prisma } from '../generated/prisma/client'
import type { NotificationType } from '../generated/prisma/enums'

const DAY_MS = 24 * 60 * 60_000

/** Лоан, якому потрібне нагадування. */
interface DueLoan {
  id: string
  copyId: string
  borrowerId: string
  dueAt: Date
}

/** Рядок, заблокований під час перечитування в транзакції. */
interface LockedLoan {
  id: string
  copyId: string
  status: string
  dueAt: Date | null
}

/**
 * §7.5, друга група: `LOAN_DUE_SOON` (рівно за 3 календарні дні до `dueAt`) і
 * `LOAN_OVERDUE`.
 *
 * Чотири речі, які тут легко зламати й важко помітити:
 *
 * 1. **`Loan.status` не змінюється.** §5.2: «`OVERDUE` — не статус». Прострочення
 *    виводиться як `status = HANDED_OVER AND dueAt < now()`, і задача лише
 *    розсилає нагадування. Проставлений статус завжди відставав би від годинника.
 *
 * 2. **`DUE_SOON` — точна календарна дата, а не ковзне вікно.** «У наступні три
 *    дні» — це умова, яка залишається істинною кілька діб поспіль: лоан із
 *    `dueAt` за два дні потрапляє в таке вікно і сьогодні, і завтра, тобто та
 *    сама подія повторюється щодня, доки термін не настане. Правильне
 *    прочитання §7.5 — «за три дні до» як одна конкретна дата: день,
 *    календарно рівно на `DUE_SOON_WINDOW_DAYS` раніший за день `dueAt`. Тоді
 *    `digestKey` (тип × людина × доба) справді дедуплікує подію на весь її
 *    життєвий цикл, а не на одну добу випадково.
 *
 * 3. **Це дайджест, а не розсилка по лоану.** §7.5 називає групу «щоденним
 *    дайджестом» саме тому, що інакше активний користувач потоне: людина з
 *    двадцятьма простроченими книжками отримала б двадцять листів і двадцять
 *    повідомлень у бота за один ранок — і вимкнула б канал разом із важливим.
 *    Тому на людину, тип і добу створюється **одна** подія, а `payload` несе
 *    кількість і перелік лоанів.
 *
 * 4. **Ідемпотентність — на рівні БД, а не прапорцем у пам'яті.** Процесів API
 *    може бути кілька (і при деплої їх завжди двоє на кілька секунд). Два
 *    незалежні воркери одночасно прочитають «сьогодні ще не надсилали» й
 *    створять дублікати — прапорець у пам'яті про сусідній процес не знає нічого.
 *    Рішення ухвалює унікальний індекс на `Notification.digestKey`: другий
 *    процес отримає порушення унікальності й тихо відступить. Це те саме, що
 *    §5.3.1 робить для лоанів: інваріант тримає база, а не домовленість.
 *
 * Перечитування умов усередині транзакції відбувається під `SELECT … FOR
 * UPDATE`, а не простим `findMany`. Без локу RETURNED міг би закомітитися між
 * читанням і записом `Notification` — вікно, у яке інший процес (звичайний
 * `LoanService.apply()`) устигає прослизнути рівно тоді, коли дайджест уже
 * вирішив, що книжка ще вдома. `LoanService` цей рядок явним локом не бере
 * (лише умовний `UPDATE … WHERE status = …`), тож лок дайджесту й запис
 * LoanService серіалізуються на одному й тому самому рядку `Loan`, а не
 * заходять по черзі на різні ресурси — дедлоку з `Copy`-локом §5.1 звідси
 * взятися нема звідки: дайджест `Copy` не чіпає.
 */
@Injectable()
export class NotificationDigestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationDigestService.name)
  private timer: NodeJS.Timeout | undefined
  private running = false
  private stopping = false
  /** Активний прохід — щоб `onModuleDestroy` чекав справжню роботу, а не оболонку. */
  private inFlight: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    /**
     * Замовчування діє лише для ручного `new` — так §7.5-тест нижче будує
     * свіжий сервіс і доводить, що перший прохід стається саме на
     * `onModuleInit`. Nest завжди передає значення з провайдера.
     */
    @Inject(BACKGROUND_MODE) private readonly background: BackgroundMode = 'enabled',
  ) {}

  onModuleInit(): void {
    // Вимкнений режим не заводить ні таймера, ні негайного проходу: в e2e
    // дайджест сканує всі HANDED_OVER-лоани спільної бази, тобто чужі.
    if (this.background === 'disabled') return

    // Той самий прийом, що в `NotificationDispatcher`: інтервал лише
    // сигналізує через `trigger()`, а не привласнює `inFlight` напряму. Пряме
    // присвоєння дало б перезапис активної роботи вже виконаною обіцянкою
    // раннього виходу, якщо тик перекрився з попереднім.
    this.timer = setInterval(() => {
      this.trigger()
    }, DIGEST_INTERVAL_MS)

    // Без unref() таймер тримає процес живим — і `jest` після e2e не завершується.
    this.timer.unref()

    // Перший прохід — одразу, а не лише за годину `DIGEST_INTERVAL_MS`.
    //
    // `LOAN_DUE_SOON` тепер точна календарна дата (не ковзне вікно): якщо
    // рестарт процесу (звичайний деплой) стається під кінець доби — скажімо,
    // о 23:30 UTC, — а перший тик інтервалу настає лише за годину, до нього
    // застосунок жодного разу не перевірить умови, поки цей момент належить
    // ЩЕ сьогоднішній календарній добі. Перший тик приїде вже о 00:30 —
    // наступного дня — і лоан, чий тригерний день був саме сьогодні,
    // втратить своє єдине DUE_SOON-вікно назавжди: подія одноразова, а не
    // вікно, що повторюється. Негайний прохід тут безпечний рівно так само,
    // як і будь-який інший: ідемпотентність тримає унікальний `digestKey`,
    // тож зайвий виклик на щойно піднятому процесі — це щонайбільше один
    // порожній прохід, а не дублікат.
    this.trigger()
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true

    if (this.timer !== undefined) clearInterval(this.timer)

    // Дочекатися прохід, який уже почався: він тримає з'єднання й, можливо,
    // лок на `Loan`, які ось-ось закриють/відпустять. `run()` не кидає.
    await this.inFlight
  }

  /**
   * Публічний тригер — той самий, яким `onModuleInit` заводить інтервал, і
   * той самий шлях, яким `inFlight` стає СПРАВЖНІМ активним проходом (а не
   * лишається старою вже виконаною обіцянкою). Прямий виклик `run()` ззовні
   * теж працює сам собою, але НЕ оновлює `inFlight` — і тест на graceful
   * shutdown, який хоче довести, що `onModuleDestroy()` реально чекає на
   * активний прохід, мусить запускати його саме так, як це робить сам
   * застосунок. Дзеркалить `NotificationDispatcher.wake()`.
   */
  wake(): void {
    this.trigger()
  }

  private trigger(): void {
    // Той самий вимикач, що й у `NotificationDispatcher`, і в тій самій єдиній
    // крапці входу: разом з інтервалом він закриває і `wake()`. Публічний
    // `run(now)` лишається робочим — саме ним користуються тести дайджесту.
    if (this.background === 'disabled') return

    if (this.stopping || this.running) return

    this.inFlight = this.run()
  }

  /**
   * Один прохід. Публічний і з керованим `now` — щоб тест не чекав годину й міг
   * поставити «завтра», не рухаючи системний час.
   *
   * Повертає кількість створених подій: саме на ній тримається перевірка
   * ідемпотентності — другий виклик поспіль має дати нуль.
   *
   * `running` — не механізм коректності, а економія на зайвих запитах у межах
   * одного процесу. Коректність тримає унікальний індекс і лок на `Loan`.
   */
  async run(now = new Date()): Promise<number> {
    if (this.running) return 0

    this.running = true

    try {
      const dueSoon = await this.emit('LOAN_DUE_SOON', now)
      const overdue = await this.emit('LOAN_OVERDUE', now)
      const total = dueSoon + overdue

      if (total > 0) {
        this.logger.log(`Дайджест: DUE_SOON ${String(dueSoon)}, OVERDUE ${String(overdue)}`)
        // §7.3: доставка — після коміту. Один поштовх на весь прохід, а не на
        // кожну подію: дайджест — це пачка, і будити диспетчер щоразу означало б
        // поводитися з ним як із негайною подією §7.5.
        this.notifications.dispatchSoon()
      }

      return total
    } catch (error) {
      // Помилка не має валити застосунок: наступний тик спробує знову.
      this.logger.error('Щоденна задача сповіщень упала', error)

      return 0
    } finally {
      this.running = false
    }
  }

  /**
   * Кандидати збираються поза транзакцією (це просто читання без наслідків), а
   * рішення для кожної людини ухвалюється всередині власної транзакції: там і
   * лок на `Loan`, і перечитування умов, і унікальний ключ доби.
   */
  private async emit(type: NotificationType, now: Date): Promise<number> {
    const loans = await this.prisma.loan.findMany({
      // Stage 10 (T1): гостьова позика (`borrowerId = NULL`) не має кому адресувати нагадування —
      // гостю нічого не надсилається, а власникові гостьові прострочення не входять у 10a.
      where: { status: 'HANDED_OVER', dueAt: { not: null }, borrowerId: { not: null } },
      select: { id: true, copyId: true, borrowerId: true, dueAt: true },
    })

    const matching = loans.filter(
      (loan): loan is DueLoan =>
        loan.dueAt !== null && loan.borrowerId !== null && matchesDigestType(type, loan.dueAt, now),
    )

    if (matching.length === 0) return 0

    const byUser = new Map<string, DueLoan[]>()

    for (const loan of matching) {
      const bucket = byUser.get(loan.borrowerId) ?? []

      bucket.push(loan)
      byUser.set(loan.borrowerId, bucket)
    }

    let created = 0

    for (const [userId, bucket] of byUser) {
      if (await this.emitFor(userId, type, bucket, now)) created += 1
    }

    return created
  }

  /**
   * Одна транзакція на людину: заблокувати рядки `Loan`, перечитати умови під
   * локом, створити подію з ключем доби.
   *
   * Порушення унікальності на `digestKey` означає «інший процес нас
   * випередив» — штатний перебіг, а не збій. Відкат тут нічого не блокує:
   * `digestKey` живе лише в закоміченому рядку, тож наступна спроба почне з
   * чистого аркуша.
   */
  private async emitFor(
    userId: string,
    type: NotificationType,
    candidates: readonly DueLoan[],
    now: Date,
  ): Promise<boolean> {
    const digestKey = `${userId}:${type}:${dayOf(now)}`

    try {
      return await this.prisma.$transaction(async (tx) => {
        // `SELECT … FOR UPDATE` — не `findMany`. Без локу RETURNED міг би
        // закомітитися між цим читанням і `INSERT` нижче: `LoanService.apply()`
        // не бере явного локу на `Loan` (лише умовний UPDATE), тож наш
        // FOR UPDATE серіалізується з ним на тому самому рядку, а не
        // заходить у чергу за іншим ресурсом — дедлоку з `Copy`-локом §5.1
        // звідси не буде: ми `Copy` не чіпаємо.
        const ids = candidates.map((loan) => loan.id)
        const locked = await tx.$queryRaw<LockedLoan[]>`
          SELECT "id", "copyId", "status", "dueAt"
          FROM "Loan"
          WHERE "id" IN (${Prisma.join(ids)}) AND "borrowerId" = ${userId}
          FOR UPDATE
        `

        const stillDue = locked
          .filter(
            (loan): loan is LockedLoan & { dueAt: Date } =>
              loan.status === 'HANDED_OVER' &&
              loan.dueAt !== null &&
              matchesDigestType(type, loan.dueAt, now),
          )
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())

        if (stillDue.length === 0) return false

        await this.notifications.create(
          {
            userId,
            type,
            payload: {
              count: String(stillDue.length),
              // §4.8: «loanId, copyId, actorId тощо» — самі ідентифікатори.
              // Перший лоан названий окремо, щоб посилання з листа вело кудись
              // конкретно, коли книжка одна (а це звичайний випадок).
              loanId: stillDue[0]?.id ?? '',
              copyId: stillDue[0]?.copyId ?? '',
              loanIds: stillDue.map((loan) => loan.id).join(','),
            },
            digestKey,
          },
          tx,
        )

        return true
      })
    } catch (error) {
      // Саме `Notification_digestKey_key`, а не будь-який P2002. Раніше тут
      // стояв загальний `isUniqueViolation` — і будь-яке ІНШЕ порушення
      // унікальності всередині цієї ж транзакції (наприклад, майбутнє
      // обмеження на іншому полі, зачеплене тим самим `create`) тихо
      // трактувалося б як «дайджест уже створено», ковтаючи справжню помилку
      // замість того, щоб її залогувати чи прокинути. `isUniqueViolationOn`
      // звіряє назву обмеження — так само, як §5.3.1 робить для лоанів.
      if (isUniqueViolationOn(error, 'Notification_digestKey_key')) {
        this.logger.debug(`Дайджест ${digestKey} уже створено — пропускаю`)

        return false
      }

      throw error
    }
  }
}

/**
 * Календарний день дати в UTC, `YYYY-MM-DD`.
 *
 * Не локальна зона процесу: два інстанси в різних зонах порахували б різні
 * дні для тієї самої миті, і рівно опівночі — момент, коли це найважче
 * помітити, — і дедуплікація, і саме тригерне вікно `DUE_SOON` розійшлися б.
 */
function calendarDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Доба в UTC — те саме, що `calendarDay`, під історичною назвою для digestKey. */
function dayOf(now: Date): string {
  return calendarDay(now)
}

/**
 * Чи відповідає лоан типу дайджесту саме зараз.
 *
 * `LOAN_OVERDUE` лишається порівнянням миті: прострочення — стан, що триває,
 * і щойно `dueAt` минув, лоан підпадає під нього щодня, аж доки не повернуть.
 *
 * `LOAN_DUE_SOON`, навпаки, — подія одного календарного дня: того, що рівно на
 * `DUE_SOON_WINDOW_DAYS` раніший за календарний день `dueAt`. Різниця дат, а не
 * різниця миттєвостей: `dueAt` може стояти на будь-якій годині своєї доби, і
 * віднімання рівно N×24 години від будь-якої точки доби `D` завжди дає ту саму
 * точку доби `D-N` — календарний день не зсувається, хоч би яка була година.
 */
function matchesDigestType(type: NotificationType, dueAt: Date, now: Date): boolean {
  if (type === 'LOAN_OVERDUE') return dueAt.getTime() < now.getTime()

  const triggerDay = calendarDay(new Date(dueAt.getTime() - DUE_SOON_WINDOW_DAYS * DAY_MS))

  return triggerDay === calendarDay(now)
}
