import 'reflect-metadata'
import { createTestApp } from './auth.helpers'
import { beginRequest, gate, waitForBlockedBackend } from './concurrency.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
  type Account,
} from './loan.helpers'
import { NotificationDigestService } from '../src/notifications/notification-digest.service'
import { NotificationsService } from '../src/notifications/notifications.service'
import { isUniqueViolationOn } from '../src/common/prisma-errors'
import { PrismaService } from '../src/prisma/prisma.service'
import type { NotificationType } from '../src/generated/prisma/enums'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

const DAY_MS = 24 * 60 * 60_000

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }

  throw new Error('Очікувалося відхилення promise, але операція завершилася успішно')
}

/**
 * §7.5, друга група: `LOAN_DUE_SOON` (рівно за 3 календарні дні) і `LOAN_OVERDUE`.
 *
 * Задача викликається руками з керованим `now` — і те, й інше принципово: чекати
 * годину неможливо, а рухати системний час означало б зламати сусідні сценарії,
 * які теж ходять у ту саму базу. Дати `DUE_SOON`-сценаріїв фіксовані
 * (`new Date('2026-…')`), а не «зараз ± N днів»: оскільки тригер тепер точний
 * календарний день, а не ковзне вікно, тест мусить сам контролювати, у якій
 * точці доби опиняється `dueAt` відносно `now` — інакше він плаває залежно від
 * того, о котрій годині його запускають.
 */
describe('Щоденна задача сповіщень (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let digest: NotificationDigestService
  let notifications: NotificationsService

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    digest = app.get(NotificationDigestService)
    notifications = app.get(NotificationsService)
  })

  afterAll(async () => {
    await app.close()
  })

  interface Scene {
    owner: Account
    borrower: Account
    loanId: string
    copyId: string
  }

  /** Книжка фізично в позичальника — інакше нагадувати про повернення нема про що. */
  async function handedOver(prefix: string, dueAt: Date | null): Promise<Scene> {
    const owner = await registerAccount(app, `${prefix}-owner`)
    const borrower = await registerAccount(app, `${prefix}-borrower`)

    await befriend(app, owner, borrower)

    const shelf = await createShelfCopy(app, owner)
    const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

    await prisma.loan.update({ where: { id: loanId }, data: { dueAt } })

    return { owner, borrower, loanId, copyId: shelf.copyId }
  }

  /** Кілька книжок в однієї людини — головний сценарій дайджесту. */
  async function handedOverMany(prefix: string, dueAt: Date, count: number): Promise<Scene[]> {
    const owner = await registerAccount(app, `${prefix}-owner`)
    const borrower = await registerAccount(app, `${prefix}-borrower`)

    await befriend(app, owner, borrower)

    const scenes: Scene[] = []

    for (let index = 0; index < count; index += 1) {
      const shelf = await createShelfCopy(app, owner)
      const loanId = await handedOverLoan(app, owner, borrower, shelf.copyId)

      await prisma.loan.update({ where: { id: loanId }, data: { dueAt } })
      scenes.push({ owner, borrower, loanId, copyId: shelf.copyId })
    }

    return scenes
  }

  function eventsFor(userId: string, type: NotificationType) {
    return prisma.notification.findMany({ where: { userId, type } })
  }

  describe('§7.5: LOAN_DUE_SOON — точно за 3 календарні дні до dueAt', () => {
    /**
     * Фіксована точка відліку для всього блоку: рівно опівдні UTC, щоб жодна
     * межа доби не потрапила в тест випадково.
     */
    const today = new Date('2026-06-10T12:00:00.000Z')

    it('dueAt рівно за 3 дні — подія сьогодні', async () => {
      const { borrower } = await handedOver('due-exact', new Date(today.getTime() + 3 * DAY_MS))

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    /**
     * Ковзне вікно «до 3 днів» ловило б і це — цей тест існує, щоб довести,
     * що воно ТЕПЕР не ловить: до триденного попередження ще одна доба.
     */
    it('dueAt за 2 дні — ще рано, подія не сьогодні', async () => {
      const { borrower } = await handedOver('due-early', new Date(today.getTime() + 2 * DAY_MS))

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)
    })

    it('dueAt за 4 дні — ще не час, подія не сьогодні', async () => {
      const { borrower } = await handedOver('due-late', new Date(today.getTime() + 4 * DAY_MS))

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)
    })

    /**
     * Календарний день, а не миттєвість: віднімання 3×24 год від БУДЬ-ЯКОЇ
     * години доби `dueAt` завжди дає ту саму годину доби `dueAt-3`, тож
     * триденний день не зсувається — хоч на початку доби, хоч наприкінці.
     */
    it('boundary: dueAt на самому початку доби D — цільовий день D-3', async () => {
      const { borrower } = await handedOver(
        'due-boundary-start',
        new Date('2026-06-13T00:00:00.000Z'),
      )

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    it('boundary: dueAt наприкінці доби D — цільовий день той самий D-3', async () => {
      const { borrower } = await handedOver(
        'due-boundary-end',
        new Date('2026-06-13T23:59:59.999Z'),
      )

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    it('лоан без терміну задачу не цікавить', async () => {
      const { borrower } = await handedOver('due-none', null)

      await digest.run(today)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)
      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(0)
    })

    /**
     * Cross-day: головний регресійний тест дефекту. Ковзне вікно «до 3 днів»
     * ловило той самий лоан і сьогодні, і завтра (dueAt наближається, але
     * лишається в межах вікна ще добу) — та сама подія повторювалася б
     * щодня, доки термін не настане. Точний календарний день має цільовий
     * день рівно один, і другого шансу зловити той самий лоан не існує.
     */
    it('той самий лоан не отримує DUE_SOON повторно наступної доби', async () => {
      const dueAt = new Date(today.getTime() + 3 * DAY_MS)
      const { borrower } = await handedOver('due-cross-day', dueAt)

      await digest.run(today)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)

      // dueAt лишається тим самим — до нього тепер лише 2 дні, а не 3.
      const tomorrow = new Date(today.getTime() + DAY_MS)

      await digest.run(tomorrow)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)

      // І позавчора (4 дні до терміну) теж нічого не додав би, якби прогін
      // траплявся тоді.
      const dayAfterTomorrow = new Date(today.getTime() + 2 * DAY_MS)

      await digest.run(dayAfterTomorrow)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })
  })

  describe('§7.5: LOAN_OVERDUE', () => {
    it('надсилається, коли термін минув', async () => {
      const now = new Date()
      const { borrower } = await handedOver('overdue', new Date(now.getTime() - DAY_MS))

      await digest.run(now)

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(1)
      // Прострочене не є «скоро повертати» — вікна не перетинаються.
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)
    })

    it('повернена книжка нагадувань не отримує', async () => {
      const now = new Date()
      const { owner, borrower, loanId } = await handedOver(
        'overdue-returned',
        new Date(now.getTime() - DAY_MS),
      )

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)
      await digest.run(now)

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(0)
    })

    /**
     * Умови перечитуються під `SELECT … FOR UPDATE` усередині транзакції — не
     * простим читанням. Тут імітується стале початкове читання (до локу), а
     * перевіряється, що саме перечитування ПІД ЛОКОМ (яке бачить реальний
     * стан бази, а мок не чіпає) зупиняє подію.
     */
    it('лоан, повернений до перечитування, у дайджест не потрапляє', async () => {
      const now = new Date()
      const { owner, borrower, loanId } = await handedOver(
        'overdue-raced',
        new Date(now.getTime() - DAY_MS),
      )

      await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

      // Тільки початкова вибірка кандидатів (поза транзакцією) підмінена
      // застарілою — recheck усередині `emitFor` іде іншим шляхом (raw SQL із
      // FOR UPDATE) і мок його не бачить.
      const stale = [{ id: loanId, copyId: '', borrowerId: borrower.id, dueAt: now }]
      const spy = jest.spyOn(prisma.loan, 'findMany').mockResolvedValueOnce(stale as never)

      await digest.run(now)

      spy.mockRestore()

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(0)
    })

    /**
     * §7.3, правило 4 і §5.1: доказовий barrier-тест того, що RETURNED не може
     * закомітитися в вікні між recheck і insert. `notifications.create()`
     * гейтується рівно в той момент, коли транзакція дайджесту вже утримує
     * `FOR UPDATE`-лок на `Loan` (recheck щойно відбувся, insert ще не
     * стався), — а конкурентний `return` намагається саме туди прослизнути.
     *
     * `waitForBlockedBackend` доводить, що `return` СПРАВДІ заблокований на
     * PostgreSQL-локу в момент звільнення гейта, а не просто «пощастило з
     * чергою мікрозадач». Результат: `return` фізично не може закомітитися,
     * поки транзакція дайджесту не звільнить лок, тобто «між SELECT і insert»
     * для RETURNED просто не існує як досяжний стан.
     */
    it('barrier: RETURNED не може закомітитися між recheck і insert дайджесту', async () => {
      const now = new Date()
      const { owner, borrower, loanId } = await handedOver(
        'overdue-barrier',
        new Date(now.getTime() - DAY_MS),
      )

      const barrier = gate()
      const originalCreate = notifications.create.bind(notifications)
      // Гейт спрацьовує ЛИШЕ на подію цього позичальника: e2e-файли ділять
      // одну базу, і на момент цього тесту в ній уже є прострочені лоани з
      // попередніх сценаріїв цього ж файлу. Без фільтра гейт міг би
      // спрацювати на транзакції ЧУЖОГО користувача — тоді `return`
      // намагався б заблокуватися на рядку, який ніхто не тримає, а
      // `waitForBlockedBackend` чесно не знайшов би контенції.
      const spy = jest.spyOn(notifications, 'create').mockImplementation(async (input, client) => {
        if (input.userId !== borrower.id) return originalCreate(input, client)

        barrier.entered.resolve()
        await barrier.release.promise

        return originalCreate(input, client)
      })

      const digestPromise = digest.run(now)

      // Дайджест уже поза recheck, лок на Loan живий, insert ще не стався.
      await barrier.entered.promise

      // Return намагається саме сюди прослизнути. `beginRequest` гарантує, що
      // запит справді пішов у мережу ЗАРАЗ, а не колись, коли хтось уперше
      // зверне увагу на цю обіцянку.
      const returnPromise = beginRequest(actOnLoan(app, owner, loanId, { action: 'return' }))

      await waitForBlockedBackend(prisma)

      barrier.release.resolve()

      const [digestCount, returnResponse] = await Promise.all([digestPromise, returnPromise])

      spy.mockRestore()

      // Дайджест побачив HANDED_OVER під локом (стан, легітимний на момент
      // recheck) і створив подію — це коректно: сам return стався пізніше,
      // фізично не міг обігнати коміт дайджесту.
      expect(digestCount).toBeGreaterThan(0)
      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(1)

      // І сам return зрештою пройшов — заблокувався, а не відмовив.
      expect(returnResponse.status).toBe(200)
      expect((await prisma.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe(
        'RETURNED',
      )
    }, 15_000)
  })

  describe('§7.5: дайджест, а не розсилка по книжці', () => {
    /**
     * Причина, чому §7.5 узагалі виділяє «щоденний дайджест»: інакше активний
     * користувач потоне. Людина з двадцятьма простроченими книжками отримала б
     * двадцять листів і двадцять повідомлень у бота за один ранок — і вимкнула б
     * канал разом із важливим.
     */
    it('на п’ять книжок однієї людини створює ОДНУ подію з ОДНИМ комплектом доставок', async () => {
      const now = new Date()
      const scenes = await handedOverMany('digest-many', new Date(now.getTime() - DAY_MS), 5)
      const borrowerId = scenes[0]?.borrower.id ?? ''

      await digest.run(now)

      const events = await eventsFor(borrowerId, 'LOAN_OVERDUE')

      expect(events).toHaveLength(1)

      const payload = events[0]?.payload as Record<string, string>

      expect(payload.count).toBe('5')
      expect(payload.loanIds?.split(',')).toHaveLength(5)

      // Один комплект доставок, а не п'ять: саме це людина побачить у пошті.
      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: events[0]?.id },
      })

      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.channel).toBe('IN_APP')
    })

    it('різні люди отримують різні дайджести', async () => {
      const now = new Date()
      const first = await handedOverMany('digest-two-a', new Date(now.getTime() - DAY_MS), 2)
      const second = await handedOverMany('digest-two-b', new Date(now.getTime() - DAY_MS), 3)

      await digest.run(now)

      expect(await eventsFor(first[0]?.borrower.id ?? '', 'LOAN_OVERDUE')).toHaveLength(1)
      expect(await eventsFor(second[0]?.borrower.id ?? '', 'LOAN_OVERDUE')).toHaveLength(1)
    })
  })

  describe('§7.5: ідемпотентність', () => {
    /**
     * Задача прокидається щогодини, тож без захисту кожен тик надсилав би те саме
     * ще раз — і за добу перетворив би бота на 24 однакові повідомлення.
     */
    it('повторний запуск у той самий момент не створює нічого', async () => {
      const now = new Date('2026-06-20T09:00:00.000Z')
      const { borrower } = await handedOver('idem-soon', new Date(now.getTime() + 3 * DAY_MS))

      expect(await digest.run(now)).toBeGreaterThan(0)
      expect(await digest.run(now)).toBe(0)
      expect(await digest.run(now)).toBe(0)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    it('протягом доби нагадування одне, наступної доби — нове', async () => {
      const now = new Date('2026-06-01T09:00:00.000Z')
      const { borrower } = await handedOver('idem-window', new Date(now.getTime() - 2 * DAY_MS))

      await digest.run(now)
      await digest.run(new Date(now.getTime() + 60 * 60_000))
      await digest.run(new Date(now.getTime() + 6 * 60 * 60_000))

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(1)

      // Наступна доба — нове нагадування: стан триває, і мовчати про нього вічно
      // теж неправильно.
      await digest.run(new Date(now.getTime() + DAY_MS))

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(2)
    })

    /**
     * Окремий доказ форми помилки, бо `run()` за контрактом ловить будь-який
     * збій верхнім catch і повертає 0. Сам конкурентний тест тому міг лишитися
     * зеленим навіть тоді, коли exact-constraint guard не впізнав справжній
     * Prisma P2002. Тут duplicate створює жива PostgreSQL, а помилка перевіряється
     * без проміжного catch сервісу.
     */
    it('живий duplicate digestKey розпізнається саме як Notification_digestKey_key', async () => {
      const account = await registerAccount(app, 'digest-p2002-shape')
      const digestKey = `${account.id}:LOAN_DUE_SOON:2026-08-19`

      await prisma.notification.create({
        data: { userId: account.id, type: 'LOAN_DUE_SOON', payload: {}, digestKey },
      })

      const error = await rejectionOf(
        prisma.notification.create({
          data: { userId: account.id, type: 'LOAN_DUE_SOON', payload: {}, digestKey },
        }),
      )

      expect(isUniqueViolationOn(error, 'Notification_digestKey_key')).toBe(true)
      expect(isUniqueViolationOn(error, 'User_email_key')).toBe(false)
    })

    /**
     * Головний тест цього файлу — і той, що не зламається локально, бо розробник
     * запускає один процес.
     *
     * Прапорець `running` у пам'яті воркера про сусідній процес не знає нічого:
     * два інстанси одночасно прочитають «сьогодні ще не надсилали» й створять
     * дублікати. Рішення ухвалює унікальний індекс на `Notification.digestKey`
     * ПЛЮС `FOR UPDATE`-лок на `Loan`: другий воркер не читає паралельно те саме
     * «ще не надіслано» — він чекає на локу, поки перший або закомітиться (і
     * тоді власний `digestKey` дасть порушення унікальності), або відкотиться.
     *
     * Барʼєр тут не просто `Promise.all`: перший воркер гейтується рівно
     * всередині своєї транзакції (лок уже узятий), другий стартує аж тоді, і
     * `waitForBlockedBackend` доводить, що другий СПРАВДІ заблокований на
     * PostgreSQL-локу — а не «випадково не встиг» посперечатися за рядок.
     *
     * Форму P2002 окремо пінує прямий live-DB тест вище. Тут перевіряється саме
     * маршрут програвшого воркера: рівно один expected duplicate/debug log і
     * жодного верхнього error log. Сам `events.length === 1` цього не довів би,
     * бо `run()` за контрактом поглинає несподіваний збій після логування.
     */
    it('два незалежні інстанси одночасно дають рівно одну подію', async () => {
      const now = new Date('2026-07-01T09:00:00.000Z')
      const { borrower } = await handedOver('idem-race', new Date(now.getTime() + 3 * DAY_MS))

      const second = new NotificationDigestService(prisma, notifications)

      const firstDebug = jest.spyOn(digest['logger'], 'debug')
      const secondDebug = jest.spyOn(second['logger'], 'debug')
      const firstError = jest.spyOn(digest['logger'], 'error')
      const secondError = jest.spyOn(second['logger'], 'error')

      const barrier = gate()
      let gated = false
      const originalCreate = notifications.create.bind(notifications)
      // Той самий фільтр за userId, що й у barrier-тесті OVERDUE: e2e-файли
      // ділять одну базу, і леткі лоани з попередніх сценаріїв могли б
      // спрацювати гейтом раніше за подію нашого позичальника. `gated`
      // додатково гарантує, що це спрацює рівно один раз — на першу спробу
      // створити ЦЮ подію, а не на кожну.
      const spy = jest.spyOn(notifications, 'create').mockImplementation(async (input, client) => {
        if (gated || input.userId !== borrower.id) return originalCreate(input, client)

        gated = true
        barrier.entered.resolve()
        await barrier.release.promise

        return originalCreate(input, client)
      })

      const firstRun = digest.run(now)

      await barrier.entered.promise

      const secondRun = second.run(now)

      await waitForBlockedBackend(prisma)

      barrier.release.resolve()

      try {
        await Promise.all([firstRun, secondRun])
      } finally {
        spy.mockRestore()
      }

      const events = await eventsFor(borrower.id, 'LOAN_DUE_SOON')

      expect(events).toHaveLength(1)
      expect(events[0]?.digestKey).toBe(`${borrower.id}:LOAN_DUE_SOON:2026-07-01`)

      // І рівно один комплект доставок — не два.
      expect(
        await prisma.notificationDelivery.count({ where: { notificationId: events[0]?.id } }),
      ).toBe(1)

      const expectedKey = `${borrower.id}:LOAN_DUE_SOON:2026-07-01`
      const duplicateLogs = [...firstDebug.mock.calls, ...secondDebug.mock.calls]
        .map((call) => String(call[0]))
        .filter((line) => line.includes(expectedKey) && line.includes('уже створено'))

      expect(duplicateLogs).toHaveLength(1)
      expect(firstError).not.toHaveBeenCalled()
      expect(secondError).not.toHaveBeenCalled()

      firstDebug.mockRestore()
      secondDebug.mockRestore()
      firstError.mockRestore()
      secondError.mockRestore()
    })

    /**
     * Дзеркальна перевірка до попереднього тесту: СТОРОННІЙ live-DB P2002 (тут
     * `User_email_key`, реально породжений duplicate INSERT) не має права
     * потрапити в гілку «дайджест уже створено». Стара версія
     * (`isUniqueViolation`, без перевірки назви
     * обмеження) мовчки проковтнула б будь-яке порушення унікальності —
     * і майбутній баг деінде в `create()` виглядав би як штатна
     * ідемпотентність дайджесту, а не як помилка, вартa розслідування.
     */
    it('сторонній P2002 (не digestKey) не потрапляє в гілку "дайджест уже створено"', async () => {
      const now = new Date('2026-08-01T09:00:00.000Z')
      const { borrower } = await handedOver('foreign-p2002', new Date(now.getTime() + 3 * DAY_MS))

      // Не підроблена форма: живий INSERT дублює email позичальника й повертає
      // справжній Prisma P2002 від PostgreSQL/driver adapter.
      const existing = await prisma.user.findUniqueOrThrow({ where: { id: borrower.id } })
      const foreignError = await rejectionOf(
        prisma.user.create({
          data: {
            email: existing.email,
            displayName: 'Duplicate email for digest test',
            passwordHash: 'not-used',
          },
        }),
      )

      expect(isUniqueViolationOn(foreignError, 'User_email_key')).toBe(true)
      expect(isUniqueViolationOn(foreignError, 'Notification_digestKey_key')).toBe(false)

      const originalCreate = notifications.create.bind(notifications)
      const spy = jest.spyOn(notifications, 'create').mockImplementation(async (input, client) => {
        if (input.userId !== borrower.id) return originalCreate(input, client)

        throw foreignError
      })

      const debugSpy = jest.spyOn(digest['logger'], 'debug')
      const errorSpy = jest.spyOn(digest['logger'], 'error')

      try {
        // run() ловить помилку на верхньому рівні (щоб один збій не валив
        // застосунок) — вона не долітає до виклику як необроблений виняток.
        await expect(digest.run(now)).resolves.toBe(0)
      } finally {
        spy.mockRestore()
      }

      // Гілка "вже створено" (debug, з текстом digestKey) НЕ спрацювала —
      // помилка не була помилково визнана порушенням `digestKey`.
      expect(debugSpy.mock.calls.some((call) => String(call[0]).includes('уже створено'))).toBe(
        false,
      )
      // Натомість вона дійшла до верхнього error-логу як справжній збій.
      expect(errorSpy).toHaveBeenCalled()

      debugSpy.mockRestore()
      errorSpy.mockRestore()

      // Жодної події не створено на цьому проході — транзакція відкотилася
      // разом із чужою помилкою.
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)

      // І це не "застрягло" назавжди: наступний прохід (без підміни)
      // створює подію нормально — сторонній P2002 не позначив цей день як
      // "уже надіслано" в digestKey.
      expect(await digest.run(now)).toBeGreaterThan(0)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    it('два інстанси на кількох людях не дублюють жодної', async () => {
      const now = new Date('2026-07-02T09:00:00.000Z')
      const people: string[] = []

      for (let index = 0; index < 3; index += 1) {
        const { borrower } = await handedOver(
          `idem-race-multi-${String(index)}`,
          new Date(now.getTime() - DAY_MS),
        )

        people.push(borrower.id)
      }

      const second = new NotificationDigestService(prisma, notifications)

      await Promise.all([digest.run(now), second.run(now)])

      for (const userId of people) {
        expect(await eventsFor(userId, 'LOAN_OVERDUE')).toHaveLength(1)
      }
    })

    /**
     * `digestKey` живе лише в закоміченому рядку, тож відкат не лишає по собі
     * «зайнятого» ключа. Інакше перший же збій бази вимикав би нагадування для
     * цієї людини до кінця доби.
     */
    it('відкат не блокує наступну успішну спробу', async () => {
      const now = new Date('2026-07-03T09:00:00.000Z')
      const { borrower } = await handedOver('idem-rollback', new Date(now.getTime() - DAY_MS))

      // Ламається запис саме цієї людини: базу ділять інші сценарії, і збій «на
      // першому виклику» дістався б комусь із них.
      const original = notifications.create.bind(notifications)
      const spy = jest.spyOn(notifications, 'create').mockImplementation(async (input, client) => {
        if (input.userId === borrower.id) throw new Error('Симульований збій запису')

        return await original(input, client)
      })

      await digest.run(now)

      // Ані події, ані «зайнятого» ключа: `digestKey` живе лише в закоміченому
      // рядку, тож відкат нічого по собі не лишає.
      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(0)

      spy.mockRestore()

      await digest.run(now)

      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(1)
    })

    /**
     * Не «глобально нуль» — e2e-файли ділять одну базу, і сусідні сценарії
     * (наприклад `loans.e2e-spec.ts`) навмисно лишають `HANDED_OVER`-лоани зі
     * старими `dueAt` для власних цілей. Перевіряється натомість те, що прохід
     * не створює подій для лоану, який свідомо поза обома вікнами.
     */
    it('лоан поза вікнами не отримує жодної події', async () => {
      const now = new Date()
      const { borrower } = await handedOver('idem-empty', new Date(now.getTime() + 30 * DAY_MS))

      await digest.run(now)

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(0)
      expect(await eventsFor(borrower.id, 'LOAN_OVERDUE')).toHaveLength(0)
    })
  })

  describe('BS-148: LOAN_DUE_SOON_OWNER — нагадування власнику', () => {
    const today = new Date('2026-06-10T12:00:00.000Z')
    const inThreeDays = new Date(today.getTime() + 3 * DAY_MS)

    it('той самий день, що й нагадування позичальнику: власнику — хто й до якого дня', async () => {
      const { owner, borrower, loanId } = await handedOver('owner-due', inThreeDays)

      await digest.run(today)

      const [event] = await eventsFor(owner.id, 'LOAN_DUE_SOON_OWNER')

      expect(event?.payload).toMatchObject({
        count: '1',
        loanId,
        actorId: borrower.id,
        dueDate: '2026-06-13',
      })
      // The borrower's reminder is unchanged and still theirs alone.
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
      expect(await eventsFor(owner.id, 'LOAN_DUE_SOON')).toHaveLength(0)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON_OWNER')).toHaveLength(0)
    })

    it('вимкнене «Нагадувати про повернення» — власнику нічого, позичальнику як і раніше', async () => {
      const { owner, borrower } = await handedOver('owner-due-off', inThreeDays)

      await prisma.user.update({ where: { id: owner.id }, data: { ownerDueReminders: false } })
      await digest.run(today)

      expect(await eventsFor(owner.id, 'LOAN_DUE_SOON_OWNER')).toHaveLength(0)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    it('не дублюється: повторний прохід тієї самої доби нічого не створює', async () => {
      const { owner } = await handedOver('owner-due-once', inThreeDays)

      await digest.run(today)
      await digest.run(new Date(today.getTime() + 60 * 60_000))

      expect(await eventsFor(owner.id, 'LOAN_DUE_SOON_OWNER')).toHaveLength(1)
    })

    it('не в той день — нічого: за 2 і за 4 дні', async () => {
      const early = await handedOver('owner-due-early', new Date(today.getTime() + 2 * DAY_MS))
      const late = await handedOver('owner-due-late', new Date(today.getTime() + 4 * DAY_MS))

      await digest.run(today)

      expect(await eventsFor(early.owner.id, 'LOAN_DUE_SOON_OWNER')).toHaveLength(0)
      expect(await eventsFor(late.owner.id, 'LOAN_DUE_SOON_OWNER')).toHaveLength(0)
    })

    it('кілька книжок одного власника — одна подія з кількістю, без імені', async () => {
      const scenes = await handedOverMany('owner-due-many', inThreeDays, 3)
      const ownerId = scenes[0]?.owner.id ?? ''

      await digest.run(today)

      const events = await eventsFor(ownerId, 'LOAN_DUE_SOON_OWNER')

      expect(events).toHaveLength(1)

      const payload = events[0]?.payload as Record<string, string>

      expect(payload.count).toBe('3')
      expect(payload.loanIds?.split(',')).toHaveLength(3)
      expect(payload).not.toHaveProperty('actorId')
    })

    it('гостьова позика теж: власнику нагадування, гостя в ньому немає', async () => {
      const owner = await registerAccount(app, 'owner-due-guest')
      const shelf = await createShelfCopy(app, owner)
      const contact = await prisma.externalBorrower.create({
        data: { ownerId: owner.id, alias: 'Сусідка Оля' },
      })
      const [, loan] = await prisma.$transaction([
        prisma.copy.update({
          where: { id: shelf.copyId },
          data: { status: 'LENT_OUT', currentHolderId: null, heldByContactId: contact.id },
        }),
        prisma.loan.create({
          data: {
            copyId: shelf.copyId,
            ownerId: owner.id,
            borrowerId: null,
            borrowerContactId: contact.id,
            borrowerKind: 'GUEST',
            origin: 'RECORDED_GUEST',
            requestedAt: null,
            status: 'HANDED_OVER',
            handedAt: new Date(today.getTime() - 7 * DAY_MS),
            dueAt: inThreeDays,
          },
        }),
      ])

      await digest.run(today)

      const [event] = await eventsFor(owner.id, 'LOAN_DUE_SOON_OWNER')
      const payload = event?.payload as Record<string, string>

      expect(payload).toMatchObject({ loanId: loan.id, guestLoan: 'true', dueDate: '2026-06-13' })
      expect(payload).not.toHaveProperty('actorId')
      expect(JSON.stringify(payload)).not.toContain('Оля')
    })
  })

  describe('§7.3: дайджест теж іде крізь доставки', () => {
    it('створює рядки NotificationDelivery, як і будь-яка інша подія', async () => {
      const now = new Date()
      const { borrower } = await handedOver('digest-delivery', new Date(now.getTime() + 3 * DAY_MS))

      await prisma.user.update({ where: { id: borrower.id }, data: { emailVerified: true } })
      await digest.run(now)

      const [notification] = await eventsFor(borrower.id, 'LOAN_DUE_SOON')

      expect(notification).toBeDefined()

      const deliveries = await prisma.notificationDelivery.findMany({
        where: { notificationId: notification?.id },
      })

      expect(deliveries.map((row) => row.channel).sort()).toEqual(['EMAIL', 'IN_APP'])
    })

    /**
     * §7.3, правило 1 — і для дайджесту теж: без переданої транзакції
     * `NotificationsService.create` відкриває власну, тож подія й доставки або
     * є разом, або їх немає зовсім.
     */
    it('подія без доставок неможлива', async () => {
      const now = new Date()
      const { borrower } = await handedOver('digest-atomic', new Date(now.getTime() + 3 * DAY_MS))

      await digest.run(now)

      const [notification] = await eventsFor(borrower.id, 'LOAN_DUE_SOON')

      expect(
        await prisma.notificationDelivery.count({ where: { notificationId: notification?.id } }),
      ).toBeGreaterThan(0)
    })
  })

  describe('§7.5: onModuleInit не чекає годину на перший прохід', () => {
    /**
     * Дефект: `onModuleInit` лише заводив `setInterval` — перший прохід
     * ставався не раніше ніж за `DIGEST_INTERVAL_MS` (година). Рестарт
     * процесу під кінець доби (звичайний деплой) міг лишити застосунок без
     * жодної перевірки якраз у ту годину, коли для когось сьогодні й був
     * єдиний тригерний день `LOAN_DUE_SOON`: подія одноразова, а не вікно, що
     * повторюється, і пропущений день не надолужити наступним тиком —
     * `matchesDigestType` для DUE_SOON уже не збігається з жодним іншим `now`.
     *
     * Тест не рухає системний час (сусідні сценарії файлу поділяють ту саму
     * базу й постраждали б від зсуву) — натомість будує `dueAt` від
     * РЕАЛЬНОГО `now()` і не чекає жодної реальної секунди понад саму
     * роботу: `onModuleDestroy()` одразу після `onModuleInit()` дочікується
     * `inFlight`, який `trigger()` встановлює лише тоді, коли справді
     * стартував `run()`. Якби подія з'являлася лише через `DIGEST_INTERVAL_MS`
     * (година), `onModuleDestroy()` розчистив би таймер до першого тика, і
     * події не було б узагалі.
     */
    it('перший прохід стається одразу на onModuleInit, а не лише за годину', async () => {
      const now = new Date()
      const { borrower } = await handedOver('init-immediate', new Date(now.getTime() + 3 * DAY_MS))

      const fresh = new NotificationDigestService(prisma, notifications)

      fresh.onModuleInit()
      await fresh.onModuleDestroy()

      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    })

    /**
     * Активний прохід, запущений негайним тригером `onModuleInit`, мусить
     * тримати `onModuleDestroy()` так само, як і прохід, запущений `run()`
     * напряму, — інакше рестарт процесу міг би обірвати щойно розпочату
     * транзакцію дайджесту (з живим локом на `Loan`) замість дочекатися її.
     */
    it('активний прохід тримає onModuleDestroy, поки не завершиться', async () => {
      const now = new Date()
      const { borrower } = await handedOver('init-shutdown', new Date(now.getTime() + 3 * DAY_MS))

      const barrier = gate()
      const originalCreate = notifications.create.bind(notifications)
      // Той самий фільтр за userId, що й у барʼєрному тесті вище: файл ділить
      // базу з сусідніми сценаріями, і без нього гейт міг би спрацювати на
      // чужій транзакції.
      const spy = jest.spyOn(notifications, 'create').mockImplementation(async (input, client) => {
        if (input.userId !== borrower.id) return originalCreate(input, client)

        barrier.entered.resolve()
        await barrier.release.promise

        return originalCreate(input, client)
      })

      const fresh = new NotificationDigestService(prisma, notifications)

      fresh.onModuleInit()

      await barrier.entered.promise

      let destroyed = false
      const destroying = fresh.onModuleDestroy().then(() => {
        destroyed = true
      })

      // Гейт іще тримає транзакцію — shutdown не має права завершитися раніше.
      await Promise.resolve()
      expect(destroyed).toBe(false)

      barrier.release.resolve()
      await destroying

      spy.mockRestore()

      expect(destroyed).toBe(true)
      expect(await eventsFor(borrower.id, 'LOAN_DUE_SOON')).toHaveLength(1)
    }, 15_000)
  })
})
