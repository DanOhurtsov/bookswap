import { HttpStatus, Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  API_ERROR_CODES,
  EMAIL_DOMAIN_BLOCKED_MESSAGE,
  isRegistrationEmailDomainBlocked,
} from '@bookswap/shared'
import type { ConfirmPasswordResetRequest, LoginRequest, RegisterRequest } from '@bookswap/shared'
import { AnalyticsService } from '../analytics/analytics.service'
import { ApiException } from '../common/api.exception'
import { isUniqueViolation } from '../common/prisma-errors'
import { EMAIL_SENDER, type EmailSender } from '../email/email-sender'
import { PrismaService } from '../prisma/prisma.service'
import { ShutdownBudget } from './auth-shutdown-budget'
import { AuthShutdownTimeoutError, type AuthShutdownPhase } from './auth-shutdown-timeout.error'
import {
  AUTH_SHUTDOWN_TIMEOUT,
  EMAIL_VERIFICATION_TTL_MS,
  PASSWORD_RESET_TTL_MS,
} from './auth.constants'
import { PasswordService } from './password.service'
import { SessionService } from './session.service'
import { generateToken, hashToken } from './tokens'
import type { UserModel } from '../generated/prisma/models'

/**
 * Геш неіснуючого пароля. Потрібен, щоб логін на невідомий email коштував рівно
 * стільки ж часу, скільки логін із неправильним паролем: інакше час відповіді
 * сам стає відповіддю на питання «чи є такий акаунт».
 */
const DUMMY_PASSWORD = 'timing-equalizer-not-a-real-password'

interface Authenticated {
  user: UserModel
  sessionToken: string
}

/**
 * Дозвіл на виконання одного auth-workflow, виданий до першої мутації.
 *
 * Workflow тут — це весь ланцюг «створити User → записати токен → поставити лист
 * → створити сесію», а не окремий запис. Поки дозвіл живий, застосунок
 * зобов'язаний дати цьому ланцюгу дійти до кінця: `onModuleDestroy` спершу
 * перестає видавати нові дозволи й лише потім чекає видані.
 *
 * Назовні з дозволу стирчить рівно одна дія — `enqueueEmail`. Так у типах
 * записано те, що інакше довелося б тримати в голові: **фоновий лист не існує
 * поза workflow**. Саме з цього випливає, що після дренажу workflow черга листів
 * уже не може поповнитися, а отже, її знімок остаточний.
 */
interface AuthWorkflow {
  enqueueEmail: (start: () => Promise<void>) => void
}

/** Той самий дозвіл, але з боку того, хто його видав і зобов'язаний повернути. */
interface AuthWorkflowReservation extends AuthWorkflow {
  release: () => void
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name)
  private dummyHash: Promise<string> | undefined
  /**
   * Auth-workflow, які вже почалися й ще не дійшли до кінця.
   *
   * Одиниця обліку тут навмисно не «фоновий лист», а **весь ланцюг** мутацій
   * одного запиту. Раніше відстежувався лише лист, і це давало вікно, у якому
   * `register()` уже закомітив `User` і токен підтвердження, а shutdown устигав
   * закрити gate рівно перед постановкою листа: запит падав із 503 **після**
   * незворотних side effects. Клієнт бачив помилку, але акаунт лишався
   * створеним — без сесії, без листа підтвердження і з адресою, яка вже зайнята,
   * тож повтор тієї самої реєстрації віддавав `EMAIL_TAKEN`. Формально вхід
   * лишався можливим (логін не вимагає `emailVerified`), але дізнатися про це
   * можна було лише здогадавшись спробувати — інтерфейс щойно повідомив, що
   * реєстрація не вдалася.
   */
  private readonly activeWorkflows = new Set<Promise<void>>()
  /**
   * Фонові auth-листи, що ще не завершилися — §7.3 логіка «черга у пам'яті
   * процесу», перенесена сюди, бо для одиничних auth-листів (не потоку
   * сповіщень) окрема таблиця й воркер були б непропорційною відповіддю.
   * Єдине, що звідси потрібно, — щоб `onModuleDestroy` не покинув лист
   * напівдорозі під час graceful shutdown; retry на рівні процесу тут
   * навмисно відсутній (див. doc-коментар `registerEmailJob`).
   */
  private readonly activeEmailJobs = new Set<Promise<void>>()
  /**
   * Єдиний gate, який узагалі бачить публічний шлях запиту. Видача дозволу й
   * закриття цього прапорця виконуються синхронно, без `await` між перевіркою й
   * `Set.add()`: workflow або цілком прийнятий і видимий shutdown, або не
   * починається взагалі — і тоді відмова приходить ДО першого запису в БД.
   */
  private acceptingWorkflows = true
  /**
   * Другий gate — суто інваріант, а не механізм відмови на шляху запиту.
   * Закривається лише після того, як жодного живого workflow не лишилося, тож
   * дійти до нього з HTTP-запиту неможливо: ставити лист у чергу вміє тільки
   * живий workflow.
   */
  private acceptingEmailJobs = true

  constructor(
    private readonly prisma: PrismaService,
    private readonly analytics: AnalyticsService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly config: ConfigService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(AUTH_SHUTDOWN_TIMEOUT) private readonly shutdownTimeoutMs: number,
  ) {}

  /**
   * Graceful shutdown у двох фазах під ОДНИМ абсолютним дедлайном.
   *
   * 1. **Закрити приймання нових workflow.** Синхронно, без жодного `await` між
   *    прапорцем і знімком: відтепер множина може тільки меншати. Запит, який
   *    прийде після цього рядка, отримає 503 ДО першого запису в БД.
   * 2. **Дочекатися вже прийнятих workflow.** Кожен із них має право дописати
   *    свої мутації й поставити лист у чергу — 503 після половини записаних
   *    side effects не буває саме тому, що дозвіл видано до них.
   * 3. **Закрити приймання листів і дочекатися їх.** Ставити лист уміє лише
   *    живий workflow, а живих після кроку 2 не лишилося, тож знімок черги
   *    остаточний: після цього дренажу жодне невідстежуване завдання вже не
   *    стартує.
   *
   * Дедлайн рахується один раз (`ShutdownBudget`), і кожна фаза отримує лише
   * залишок. Стеля «на фазу» перетворила б задокументовані тридцять секунд на
   * шістдесят — обіцянку, якої код не тримає.
   *
   * **Вичерпаний бюджет — це не успішний drain.** Фаза 1, що не дочекалася
   * workflow, кидає `AuthShutdownTimeoutError` і НЕ йде далі: жодного
   * «усі workflow завершено» в лог, жодного закриття email-gate під живим
   * workflow. Це принципово — виданий дозвіл лишається чинним, тож workflow, що
   * доживе до `enqueueEmail`, поставить лист у ВІДКРИТИЙ gate, а не отримає
   * відмову вже після створених `User` і токена. Скасувати його з відкотом усіх
   * side effects ми не можемо (мутації йдуть окремими транзакціями), тож єдина
   * чесна альтернатива — не вдавати, що зупинка вдалася.
   *
   * **Межа цієї гарантії.** «Прийнятий workflow буде доведено до кінця» вірне
   * рівно доти, доки drain укладається в бюджет. На справжньому SIGTERM Nest 11
   * ловить помилку з `close()`, пише `ERROR_DURING_SHUTDOWN` і **одразу
   * викликає `process.exit(1)`** — тобто після вичерпаного бюджету процес
   * зникає з тим самим ефектом, що й аварійне завершення: workflow, який усе ще
   * працював, обривається посеред ланцюга окремих транзакцій, і в базі
   * лишаються часткові side effects (`User` без токена підтвердження, `User`
   * без сесії, ненадісланий лист). Fail-loud policy цього не лікує — вона лише
   * не дає видати тайм-аут за успішний drain. Прибрати ризик остаточно можна
   * лише іншою конструкцією (transactional outbox або атомарніший
   * auth-workflow); в етапі 6 вона свідомо не реалізована, тут вона зафіксована
   * як відома межа.
   *
   * Обидва очікування — це `Promise.allSettled` по **фіксованому знімку**, а не
   * цикл «поки не спорожніє»: така форма завершується структурно, її не можна
   * годувати новою роботою без кінця.
   */
  async onModuleDestroy(): Promise<void> {
    const budget = new ShutdownBudget(this.shutdownTimeoutMs)

    this.acceptingWorkflows = false

    const workflows = [...this.activeWorkflows]

    this.logger.log(
      `Зупинка auth: приймання нових workflow закрито, у роботі: ${String(workflows.length)}, ` +
        `загальний бюджет: ${String(budget.totalMs)} мс`,
    )
    await this.settlePhase(workflows, 'workflow', budget)
    this.logger.log('Зупинка auth: усі прийняті workflow завершено')

    // Лише тут — жодного живого workflow вже немає, тож нову роботу в чергу
    // нікому поставити, і знімок нижче остаточний.
    this.acceptingEmailJobs = false

    const jobs = [...this.activeEmailJobs]

    this.logger.log(`Зупинка auth-email: gate закрито, очікую завдань: ${String(jobs.length)}`)
    await this.settlePhase(jobs, 'email', budget)
    this.logger.log('Зупинка auth-email: усі прийняті завдання завершено')
  }

  /**
   * Явний drain для тестів і звичайного коду, поки lifecycle gate іще відкритий.
   *
   * На відміну від `onModuleDestroy`, тут gate НЕ закривається, тож одноразовий
   * знімок чекав би лише те, що встигло зареєструватися до виклику: workflow,
   * який щойно дійшов до контролера, поставить свій лист уже під час
   * очікування. Тому метод повторює прохід, доки обидві множини не спорожніють
   * одночасно. Сам shutdown на такий цикл НЕ покладається — там знімок
   * остаточний за побудовою.
   *
   * Цикл обмежений тим самим загальним бюджетом і при його вичерпанні кидає
   * помилку: у тесті мовчазне «висить назавжди» — найгірший із можливих
   * діагнозів.
   */
  async drainBackgroundWork(): Promise<void> {
    const budget = new ShutdownBudget(this.shutdownTimeoutMs)

    while (this.activeWorkflows.size > 0 || this.activeEmailJobs.size > 0) {
      const drained = await this.settle(
        [...this.activeWorkflows, ...this.activeEmailJobs],
        budget.remainingMs(),
      )

      if (!drained) {
        throw new Error(`Фонова auth-робота не завершилася за ${String(budget.totalMs)} мс`)
      }
    }
  }

  /**
   * Синхронно видає дозвіл на один auth-workflow — або відмовляє.
   *
   * Синхронність тут не стилістична: між перевіркою прапорця й `Set.add()`
   * немає жодного `await`, тож не існує стану «shutdown уже почався, а workflow
   * ще ніде не видно». Викликати цей метод треба ДО першої мутації — тоді
   * відмова (503) фізично не може статися після незворотного запису.
   */
  private reserveWorkflow(context: string): AuthWorkflowReservation {
    if (!this.acceptingWorkflows) {
      this.logger.warn(`Auth-workflow (${context}) відхилено: застосунок завершує роботу`)

      throw shuttingDown()
    }

    let finish!: () => void
    const tracked = new Promise<void>((resolve) => {
      finish = resolve
    })

    this.activeWorkflows.add(tracked)

    let live = true

    return {
      enqueueEmail: (start) => {
        // Дозвіл уже повернено — значить, shutdown міг порахувати цей workflow
        // завершеним. Ставити звідси лист означало б завести завдання, якого
        // ніхто не чекає; це помилка програміста, а не режим роботи.
        if (!live) {
          throw new Error(`Фоновий лист (${context}) поставлено після завершення workflow`)
        }

        this.registerEmailJob(start, context)
      },
      release: () => {
        if (!live) return

        live = false
        this.activeWorkflows.delete(tracked)
        finish()
      },
    }
  }

  /** Обгортка «взяти дозвіл → виконати → неодмінно повернути». */
  private async runWorkflow<T>(
    context: string,
    run: (workflow: AuthWorkflow) => Promise<T>,
  ): Promise<T> {
    // `async`-функція виконується синхронно до першого `await`, тож дозвіл
    // береться в тому ж turn, у якому викликач звернувся до сервісу.
    const reservation = this.reserveWorkflow(context)

    try {
      return await run(reservation)
    } finally {
      reservation.release()
    }
  }

  /**
   * Реєструє фонове auth-завдання (лист або процес скидання пароля, що сам
   * його надсилає) і **не чекає** на нього — викликач (`register()`,
   * `requestPasswordReset()`) отримує відповідь, щойно синхронна частина
   * завершена, а не коли провайдер відповість.
   *
   * Це найменший безпечний механізм, а не durable outbox: жодної таблиці
   * черги, жодного retry між процесами. Обране свідомо — для одиничних
   * auth-листів (не потоку сповіщень §7.3, де черга й ретраї вже є)
   * повноцінний outbox був би непропорційною відповіддю на «не блокуй
   * публічний ендпоінт». Ціна цього вибору чесно записана в двох місцях:
   * збій провайдера тут лишається лише в логах (без ретраю), а лист, що не
   * встиг стартувати до аварійного (не graceful) завершення процесу,
   * втрачається — але саме для GRACEFUL shutdown `onModuleDestroy` вище
   * закриває це вікно.
   *
   * Приватний і викликається лише з `reserveWorkflow().enqueueEmail` — тобто
   * завжди з-під живого дозволу.
   */
  private registerEmailJob(start: () => Promise<void>, context: string): void {
    if (!this.acceptingEmailJobs) {
      // Недосяжно за інваріантом: цей gate закривається лише після дренажу всіх
      // workflow, а без живого workflow сюди не потрапити. Перевірка лишається
      // як запобіжник — краще гучна помилка, ніж лист, якого ніхто не чекає.
      throw new Error(`Фоновий лист (${context}) не стартував: auth-email gate уже закритий`)
    }

    // `then(start)` відкладає фактичний старт до microtask. Promise потрапляє в
    // Set синхронно раніше, ніж `start` може виконати бодай один зовнішній
    // ефект; закриття gate в сусідньому turn уже гарантовано побачить цей job.
    const job = Promise.resolve().then(start)

    this.activeEmailJobs.add(job)

    job
      .catch((error: unknown) => {
        this.logger.error(`Фонове завдання (${context}) не вдалося`, error)
      })
      .finally(() => {
        this.activeEmailJobs.delete(job)
      })
  }

  /**
   * Одна фаза дренажу під спільним дедлайном: або дочекалася, або зупиняє весь
   * shutdown помилкою.
   *
   * Саме тут політика «тайм-аут ≠ успіх» стає кодом. Викликач не отримує назад
   * прапорця, який можна проігнорувати: невдала фаза кидає, і все, що йшло б
   * після неї (успішний лог, закриття наступного gate), не виконується взагалі.
   *
   * Фаза не рахує собі стелю сама, а бере залишок у спільного `budget` — тому
   * «друга фаза не отримує нову повну стелю» перевіряється детерміновано в
   * `auth-shutdown-budget.spec.ts`, без wall-clock.
   */
  private async settlePhase(
    jobs: Promise<unknown>[],
    phase: AuthShutdownPhase,
    budget: ShutdownBudget,
  ): Promise<void> {
    const phaseBudgetMs = budget.remainingMs()

    if (await this.settle(jobs, phaseBudgetMs)) return

    const pending = phase === 'workflow' ? this.activeWorkflows.size : this.activeEmailJobs.size
    const error = new AuthShutdownTimeoutError(
      phase,
      pending,
      budget.totalMs,
      budget.deadlineAt,
      phaseBudgetMs,
    )

    this.logger.error(error.message)

    throw error
  }

  /**
   * Чекає знімок завдань, але не довше за виділений бюджет. Повертає `true`,
   * якщо все завершилося, і `false`, якщо бюджет вичерпано.
   *
   * `unref()` на таймері обов'язковий: інакше сама стеля тримала б event loop
   * живим ще пів хвилини після того, як чекати вже нема чого, і `app.close()`
   * не давав би процесу вийти.
   */
  private settle(jobs: Promise<unknown>[], budgetMs: number): Promise<boolean> {
    if (jobs.length === 0) return Promise.resolve(true)
    // Бюджет уже з'їли попередні фази — чекати нема на що, і це саме тайм-аут,
    // а не «встигли».
    if (budgetMs <= 0) return Promise.resolve(false)

    let timer: NodeJS.Timeout | undefined
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(false)
      }, budgetMs)
      timer.unref()
    })

    return Promise.race([Promise.allSettled(jobs).then(() => true), expired]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  async register(request: RegisterRequest): Promise<Authenticated> {
    // Дозвіл береться ПЕРШИМ — до хешування пароля й до будь-якого звернення до
    // БД. Усе, що нижче, виконується під ним до кінця навіть якщо SIGTERM
    // прилетить наступної мілісекунди.
    const authenticated = await this.runWorkflow('реєстрація', async (workflow) => {
      // BS-129: checked here and not only in the DTO or the form, so that no caller
      // can create an account on a blocked domain. It comes before the password hash
      // and every write: a refusal leaves no User, session, token, email or event.
      if (isRegistrationEmailDomainBlocked(request.email)) throw emailDomainBlocked()

      const passwordHash = await this.passwords.hash(request.password)

      const existing = await this.prisma.user.findUnique({
        where: { email: request.email },
        select: { id: true },
      })

      if (existing !== null) throw emailTaken()

      let user: UserModel

      try {
        user = await this.prisma.user.create({
          data: {
            email: request.email,
            passwordHash,
            displayName: request.displayName,
          },
        })
      } catch (error) {
        // Перевірка вище не рятує від двох одночасних реєстрацій — останнє слово
        // за унікальним індексом на User.email.
        if (isUniqueViolation(error)) throw emailTaken()
        throw error
      }

      // `sendEmailVerification` сама не чекає на провайдера (лист іде фоновим
      // завданням через `enqueueEmail`, без `await`) — тут дочікуємося лише
      // швидкого запису токена в БД. Якби сам лист чекали тут, збій провайдера кидав би
      // помилку вже ПІСЛЯ того, як User закомічений: клієнт отримав би 500 на
      // адресу, яку вже не звільнити, а повторна реєстрація тим самим email
      // після такого 500 давала б EMAIL_TAKEN — людина не змогла б ні
      // зареєструватися, ні второпати, що акаунт узагалі створився. Відновити
      // пропущений лист можна кнопкою «Надіслати ще раз» у профілі
      // (`resendEmailVerification`), яка йде тим самим шляхом.
      await this.sendEmailVerification(user, workflow)

      // Реєстрація одразу створює сесію: інакше єдина дія нового користувача —
      // чекати листа, а в dev пошта нікуди не йде. Доступ при цьому лишається
      // обмеженим прапорцем emailVerified, який фронт показує в профілі.
      return { user, sessionToken: await this.sessions.create(user.id) }
    })

    await this.analytics.record({
      type: 'SIGNUP_COMPLETED',
      subjectUserId: authenticated.user.id,
      domainEntityId: authenticated.user.id,
      properties: {},
    })

    return authenticated
  }

  async login(request: LoginRequest): Promise<Authenticated> {
    const user = await this.prisma.user.findUnique({ where: { email: request.email } })

    if (user === null) {
      await this.passwords.verify(request.password, await this.dummyPasswordHash())
      throw invalidCredentials()
    }

    if (!(await this.passwords.verify(request.password, user.passwordHash))) {
      throw invalidCredentials()
    }

    return { user, sessionToken: await this.sessions.create(user.id) }
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (sessionToken === undefined) return

    await this.sessions.revoke(sessionToken)
  }

  /**
   * Повторне надсилання листа. Для вже підтвердженої адреси не робить нічого.
   *
   * Дозвіл береться до перевірки `emailVerified`, а не після: правило «кожен
   * мутуючий вхід резервує workflow на вході» простіше і перевірити, і не
   * зламати наступною зміною, ніж «резервує, якщо далі справді щось запише».
   */
  async resendEmailVerification(user: UserModel): Promise<void> {
    await this.runWorkflow('повторний лист підтвердження', async (workflow) => {
      if (user.emailVerified) return

      await this.sendEmailVerification(user, workflow)
    })
  }

  async confirmEmail(token: string): Promise<UserModel> {
    const tokenHash = hashToken(token)

    return this.prisma.$transaction(async (tx) => {
      const record = await tx.emailVerificationToken.findUnique({ where: { tokenHash } })

      if (record === null || !isUsable(record)) throw invalidToken()

      // Одноразовість тримається саме тут: умова `usedAt: null` в UPDATE робить
      // погашення токена атомарним. Дві паралельні спроби — рівно одна з count 1.
      const claimed = await tx.emailVerificationToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      })

      if (claimed.count !== 1) throw invalidToken()

      return tx.user.update({ where: { id: record.userId }, data: { emailVerified: true } })
    })
  }

  /**
   * §6.1 і вимога етапу: відповідь не залежить від того, чи зареєстрований email.
   * Викликач завжди отримує «прийнято» — і сам метод нічого не повертає.
   *
   * **Увесь** обробіток — і пошук `User`, і запис токена, і сам лист — тепер
   * фоновим завданням (`processPasswordReset`, не `await`-иться тут). Раніше
   * лише лист ішов у фоні: гілка для невідомої адреси поверталася миттєво
   * (жодного звернення до бази чи пошти), а відома — усе одно чекала на
   * `await this.prisma.passwordResetToken.create(...)` тут-таки, у шляху
   * запиту, ДО того, як лист ставав фоновим. Один зайвий `INSERT` — це не
   * мережева затримка провайдера, але це так само вимірювана різниця в часі
   * відповіді між «є акаунт» і «нема акаунта», а вимога §6.1 — про факт
   * відмінності, а не про її причину. Тепер синхронна частина цього методу —
   * рівно взяти дозвіл і поставити завдання: обидві гілки (відома/невідома
   * адреса) повертаються з однаковою швидкістю незалежно від того, що там
   * усередині виявиться, бо саме це «усередині» ще навіть не почало
   * виконуватися.
   *
   * Дозвіл повертається одразу: увесь запис до БД тут живе всередині фонового
   * завдання, а завдання вже зареєстроване й буде дочекане фазою 3 shutdown'у.
   * Відмова ж (503, якщо приймання закрите) приходить до того, як хоч щось
   * записано, — і однаково для обох гілок, тож §6.1 не страждає.
   */
  requestPasswordReset(email: string): void {
    const reservation = this.reserveWorkflow('скидання пароля')

    try {
      reservation.enqueueEmail(() => this.processPasswordReset(email))
    } finally {
      reservation.release()
    }
  }

  /** Фактичний обробіток `requestPasswordReset` — див. коментар там. */
  private async processPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } })

    if (user === null) {
      // У лог, не у відповідь: адміністратору знати корисно, тому, хто перебирає
      // адреси, — ні.
      this.logger.log('Запит на скидання пароля для невідомої адреси')
      return
    }

    const token = generateToken()

    await this.prisma.passwordResetToken.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    })

    await this.email.send({
      to: user.email,
      subject: 'BookSwap: скидання пароля',
      body:
        `Щоб задати новий пароль, перейдіть за посиланням:\n` +
        `${this.link('/reset-password', token)}\n\n` +
        `Посилання дійсне годину. Якщо ви цього не просили — просто зігноруйте лист.`,
    })
  }

  async confirmPasswordReset(request: ConfirmPasswordResetRequest): Promise<void> {
    const tokenHash = hashToken(request.token)
    const passwordHash = await this.passwords.hash(request.password)

    await this.prisma.$transaction(async (tx) => {
      const record = await tx.passwordResetToken.findUnique({ where: { tokenHash } })

      if (record === null || !isUsable(record)) throw invalidToken()

      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data: { usedAt: new Date() },
      })

      if (claimed.count !== 1) throw invalidToken()

      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } })

      // Решта невикористаних токенів цього користувача теж гасяться: інакше лист,
      // замовлений двічі, лишає другий ключ від акаунта чинним.
      await tx.passwordResetToken.updateMany({
        where: { userId: record.userId, usedAt: null },
        data: { usedAt: new Date() },
      })

      // Зміна пароля розлогінює всюди — інакше той, хто вкрав сесію, лишається
      // всередині саме тоді, коли жертва рятує акаунт.
      await this.sessions.revokeAllForUser(record.userId, tx)
    })
  }

  /**
   * ДБ-запис токена лишається в синхронному шляху (`await`-иться викликачем):
   * швидкий, не залежить від зовнішнього провайдера, і кнопка «Надіслати ще
   * раз» (`resendEmailVerification`) має що погашати одразу, а не чекати,
   * доки фонове завдання щойно розпочатого запиту його створить. На відміну
   * від `requestPasswordReset`, тут немає «відомий/невідомий email» гілки, яку
   * цей зайвий запис міг би видати: `register()` уже відкинув дублікат вище
   * (`emailTaken()`), а `resendEmailVerification()` викликається лише за
   * автентифікованою сесією.
   *
   * Сам лист — через `workflow.enqueueEmail`: метод повертається, щойно токен
   * записано, а не коли провайдер відповість. `workflow` передається
   * параметром, а не береться з поля сервісу, саме щоб постановка листа була
   * можлива лише з-під живого дозволу викликача.
   */
  private async sendEmailVerification(user: UserModel, workflow: AuthWorkflow): Promise<void> {
    const token = generateToken()

    await this.prisma.emailVerificationToken.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
      },
    })

    workflow.enqueueEmail(() =>
      this.email.send({
        to: user.email,
        subject: 'BookSwap: підтвердіть адресу',
        body:
          `Вітаємо, ${user.displayName}!\n\n` +
          `Підтвердіть адресу за посиланням:\n` +
          `${this.link('/verify-email', token)}\n\n` +
          `Посилання дійсне добу.`,
      }),
    )
  }

  /** Посилання ведуть на фронт, не на API: токен гаситься дією користувача. */
  private link(path: string, token: string): string {
    const base = this.config.getOrThrow<string>('WEB_ORIGIN')

    return `${base}${path}?token=${encodeURIComponent(token)}`
  }

  private dummyPasswordHash(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(DUMMY_PASSWORD)

    return this.dummyHash
  }
}

function isUsable(record: { usedAt: Date | null; expiresAt: Date }): boolean {
  return record.usedAt === null && record.expiresAt.getTime() > Date.now()
}

function emailTaken(): ApiException {
  return new ApiException(
    API_ERROR_CODES.EMAIL_TAKEN,
    'Акаунт із такою адресою вже існує',
    HttpStatus.CONFLICT,
  )
}

function emailDomainBlocked(): ApiException {
  return new ApiException(
    API_ERROR_CODES.EMAIL_DOMAIN_BLOCKED,
    EMAIL_DOMAIN_BLOCKED_MESSAGE,
    HttpStatus.BAD_REQUEST,
  )
}

function invalidCredentials(): ApiException {
  return new ApiException(
    API_ERROR_CODES.INVALID_CREDENTIALS,
    'Невірна пошта або пароль',
    HttpStatus.UNAUTHORIZED,
  )
}

/**
 * Єдина відмова, яку взагалі вміє віддавати lifecycle gate — і вона завжди
 * приходить ДО першої мутації, тож повторити запит справді можна: нічого
 * незворотного за нею не стоїть.
 */
function shuttingDown(): ApiException {
  return new ApiException(
    API_ERROR_CODES.INTERNAL_ERROR,
    'Застосунок завершує роботу. Спробуйте запит ще раз за кілька секунд.',
    HttpStatus.SERVICE_UNAVAILABLE,
  )
}

function invalidToken(): ApiException {
  return new ApiException(
    API_ERROR_CODES.INVALID_TOKEN,
    'Посилання недійсне або вже використане',
    HttpStatus.BAD_REQUEST,
  )
}
