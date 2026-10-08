import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { DevEmailSender } from '../../src/email/dev-email-sender'
import { EMAIL_SENDER, type EmailMessage, type EmailSender } from '../../src/email/email-sender'
import { NotificationDispatcher } from '../../src/notifications/notification-dispatcher.service'
import { PrismaService } from '../../src/prisma/prisma.service'
import { createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { createShelfCopy } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * Stage 10, 10i.3: АВТОМАТИЧНИЙ браузерний e2e повного потоку гостьового підтвердження на синтетичних даних.
 * Це НЕ ручне QA (воно відкладене до перевірки перед beta): реальні web (`next dev`) і API (у цьому ж
 * процесі, `createTestApp`) поверх тестової БД, справжній Chromium.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser` (передумови — `apps/api/README`-розділ у
 * docs/runbooks/guest-loans-safeguard.md: `pnpm install`, `pnpm --filter @bookswap/api exec playwright-core
 * install chromium`, `pnpm db:up`). Без Chromium тест ПАДАЄ (не пропускається).
 *
 * Код гостя береться з `DevEmailSender.sealedTo()` у цьому процесі — без dev-файла, debug endpoint чи лога.
 *
 * Сценарії:
 *  1. RECEIVED, посилання COPY, адреса гостя B (@guest.invalid).
 *  2. DENIED, посилання листом на адресу A, а гість вводить ІНШУ адресу B (A ≠ B).
 * У кожному — окремо перевіряється лист власнику (загальний, у фактично переданому `EmailSender.send`).
 */
const PASSWORD = 'dovhyj-parol-2026'
const GENERIC_SUBJECT = 'У вас нове повідомлення в BookSwap'

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
const webOrigin = WEB_ORIGIN
let prisma: PrismaService
let mail: DevEmailSender
let dispatcher: NotificationDispatcher
let sender: EmailSender
let sentMessages: EmailMessage[] = []
const contexts: BrowserContext[] = []

beforeAll(async () => {
  app = await createTestApp()
  prisma = app.get(PrismaService)
  mail = app.get(DevEmailSender)
  dispatcher = app.get(NotificationDispatcher)
  sender = app.get<EmailSender>(EMAIL_SENDER)

  // Fail-closed: інжектований відправник — саме локальний DevEmailSender, а не Resend чи інший транспорт.
  if (!(sender instanceof DevEmailSender) || sender !== mail) {
    throw new Error('Браузерний e2e вимагає локальний DevEmailSender як EMAIL_SENDER')
  }

  const original = sender.send.bind(sender)

  jest.spyOn(sender, 'send').mockImplementation((message) => {
    sentMessages.push(message)

    return original(message)
  })

  web = await startWeb(app, WEB_PORT, webOrigin)

  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)

  await stopWeb(web)

  await app?.close()
})

afterEach(() => {
  sentMessages = []
})

interface Owner {
  id: string
  email: string
  displayName: string
  alias: string
  copyId: string
  bookTitle: string
}

async function seedOwner(prefix: string): Promise<Owner> {
  const email = uniqueEmail(prefix)
  const displayName = `Власник ${prefix} ${String(process.pid)}`
  const registered = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({ email, password: PASSWORD, displayName })
    .expect(201)
  const id = (registered.body as { user: { id: string } }).user.id
  const account = { id, cookie: sessionCookie(registered.headers), displayName }
  const shelf = await createShelfCopy(app, account)
  const alias = `Аліас ${prefix} ${String(Date.now())}`

  await request(app.getHttpServer())
    .post('/api/v1/me/external-borrowers')
    .set('Cookie', account.cookie)
    .send({ alias, ownerInformed: true })
    .expect(201)

  // Підтверджена пошта — щоб EMAIL-доставку власнику було створено за звичайними правилами.
  await prisma.user.update({ where: { id }, data: { emailVerified: true } })

  // Лист підтвердження адреси від реєстрації — не предмет перевірки: рахуємо лише те, що піде далі.
  sentMessages = []

  const work = await prisma.work.findUniqueOrThrow({
    where: { id: shelf.workId },
    select: { title: true },
  })

  return { id, email, displayName, alias, copyId: shelf.copyId, bookTitle: work.title }
}

async function newPage(): Promise<Page> {
  const context = await browser.newContext()

  contexts.push(context)

  return context.newPage()
}

async function settle(page: Page): Promise<void> {
  // Форми працюють лише після гідрації: без цього клік/submit до неї — дія в нікуди.
  await page.waitForLoadState('networkidle')
}

async function login(page: Page, owner: Owner): Promise<void> {
  await page.goto(`${webOrigin}/login`)
  await settle(page)
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Пароль').fill(PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL((url) => !url.pathname.startsWith('/login'))
}

/** Власник у браузері: бібліотека → «Позичити гостю» → запит підтвердження → сторінка запиту. */
async function ownerCreatesRequest(page: Page, owner: Owner): Promise<string> {
  await page.goto(`${webOrigin}/library`)
  await settle(page)
  await page.getByRole('button', { name: 'Позичити гостю' }).click()
  await page.locator(`#guest-contact-${owner.copyId}`).selectOption({ label: owner.alias })
  await page.locator(`#guest-handed-${owner.copyId}`).fill('2026-01-01')
  await page.getByRole('button', { name: 'Записати й попросити підтвердження гостя' }).click()
  await page.getByRole('link', { name: 'Видати посилання гостю' }).click()
  await page.waitForURL(/\/loans\/guest\?confirmationId=/)
  await settle(page)

  return new URL(page.url()).searchParams.get('confirmationId') ?? ''
}

function guestUrlFromSealed(address: string): string {
  const body = mail.sealedTo(address)?.body ?? ''
  const match = /https?:\/\/\S+#\S+/.exec(body)

  if (match === null) throw new Error('У запечатаному листі гостю немає посилання')

  return match[0]
}

async function codeFor(address: string): Promise<string> {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const code = /Код підтвердження: (\d{6})/.exec(mail.sealedTo(address)?.body ?? '')?.[1]

    if (code !== undefined) return code

    await new Promise((r) => setTimeout(r, 250))
  }

  throw new Error('Код не надійшов у запечатаний лист')
}

/** Гість без акаунта: посилання → нікнейм і адреса B → код → відповідь. Повертає нікнейм. */
async function guestAnswers(
  guestPage: Page,
  link: string,
  owner: Owner,
  guestEmail: string,
  answer: 'RECEIVED' | 'DENIED',
): Promise<string> {
  const nickname = `Нікнейм-${String(Date.now())}`

  await guestPage.goto(link)
  await guestPage.getByRole('heading', { name: 'Підтвердження отримання книжки' }).waitFor()
  await guestPage.getByLabel('Нікнейм').waitFor()

  // Фрагмент із токеном прибрано з адресного рядка.
  await guestPage.waitForFunction(() => window.location.hash === '')
  expect(guestPage.url()).not.toContain('#')
  expect(guestPage.url()).toBe(`${webOrigin}/guest-loan-confirmation`)

  // Дозволений контекст: назва книжки є; приватного (alias, ім'я й пошта власника) — ні.
  const bodyText = await guestPage.locator('body').innerText()

  expect(bodyText).toContain(owner.bookTitle)

  for (const hidden of [owner.alias, owner.displayName, owner.email, '2026-01-01']) {
    expect(bodyText).not.toContain(hidden)
  }

  await settle(guestPage)
  await guestPage.getByLabel('Нікнейм').fill(nickname)
  await guestPage.getByLabel('Ваша адреса пошти').fill(guestEmail)
  await guestPage.getByRole('button', { name: 'Надіслати код' }).click()

  const code = await codeFor(guestEmail)

  await guestPage.getByLabel('Код із листа').fill(code)
  await guestPage.getByRole('button', { name: 'Підтвердити код' }).click()
  await guestPage.getByText('Адресу підтверджено').waitFor()
  await guestPage
    .getByRole('button', { name: answer === 'RECEIVED' ? 'Отримав книжку' : 'Не отримував' })
    .click()
  await guestPage.getByRole('heading', { name: 'Відповідь записано' }).waitFor()

  return nickname
}

/** Лист власнику — саме те, що фактично передано в `EmailSender.send`. */
async function expectGenericOwnerMail(
  owner: Owner,
  guestEmails: readonly string[],
  secrets: readonly string[],
): Promise<void> {
  await dispatcher.run()

  const toOwner = sentMessages.filter((message) => message.to === owner.email)

  expect(toOwner).toHaveLength(1)
  expect(toOwner[0]?.subject).toBe(GENERIC_SUBJECT)
  expect(toOwner[0]?.body).toBe(
    `${GENERIC_SUBJECT}\n\nЩоб його прочитати, увійдіть у BookSwap: ${webOrigin}/login`,
  )
  expect(toOwner[0]?.sealed).toBeUndefined()

  const haystack = JSON.stringify(toOwner)

  for (const secret of [...secrets, owner.bookTitle, owner.alias, ...guestEmails]) {
    expect(haystack).not.toContain(secret)
  }

  // Усе інше, що пішло в `EmailSender`, — запечатані листи гостю на його адреси, нічого не власнику.
  for (const message of sentMessages.filter((m) => m.to !== owner.email)) {
    expect(guestEmails).toContain(message.to)
    expect(message.sealed).toBe(true)
  }
}

async function expectOwnerSees(
  ownerPage: Page,
  confirmationId: string,
  evidence: string,
  notification: string,
): Promise<void> {
  await ownerPage.goto(`${webOrigin}/loans/guest?confirmationId=${confirmationId}`)
  await settle(ownerPage)
  await ownerPage.getByText(evidence, { exact: false }).first().waitFor()

  await ownerPage.goto(`${webOrigin}/notifications`)
  await settle(ownerPage)
  await ownerPage.getByText(notification, { exact: true }).waitFor()
  await ownerPage.getByRole('link', { name: 'Відкрити запит підтвердження' }).waitFor()
}

describe('Stage 10 (10i.3): браузерний потік гостьового підтвердження', () => {
  it('RECEIVED: посилання COPY, гість без акаунта, адреса B; власник бачить результат і сповіщення', async () => {
    const owner = await seedOwner('br-received')
    const guestEmail = `b-received-${String(Date.now())}@guest.invalid`
    const ownerPage = await newPage()

    await login(ownerPage, owner)

    const confirmationId = await ownerCreatesRequest(ownerPage, owner)

    await ownerPage.getByRole('button', { name: 'Видати посилання (скопіювати)' }).click()

    const link = await ownerPage.getByRole('textbox', { name: 'Посилання для гостя' }).inputValue()

    expect(link).toMatch(/\/guest-loan-confirmation#/)

    const guestPage = await newPage()
    const nickname = await guestAnswers(guestPage, link, owner, guestEmail, 'RECEIVED')

    await expectOwnerSees(
      ownerPage,
      confirmationId,
      'підтверджено гостем',
      'Гість підтвердив отримання книжки',
    )

    const rows = await prisma.notification.findMany({
      where: { userId: owner.id, type: { in: ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] } },
      include: { deliveries: true },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('GUEST_LOAN_RECEIVED')
    expect(rows[0]?.deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'IN_APP'])

    await expectGenericOwnerMail(
      owner,
      [guestEmail],
      [nickname, 'отрим', 'RECEIVED', confirmationId],
    )
  })

  it('DENIED, A ≠ B: посилання листом на адресу A, гість підтверджує іншу адресу B', async () => {
    const owner = await seedOwner('br-denied')
    const addressA = `a-denied-${String(Date.now())}@guest.invalid`
    const addressB = `b-denied-${String(Date.now())}@guest.invalid`
    const ownerPage = await newPage()

    expect(addressA).not.toBe(addressB)

    await login(ownerPage, owner)

    const confirmationId = await ownerCreatesRequest(ownerPage, owner)

    await ownerPage.getByLabel('Тестовий лист: адреса доставки').fill(addressA)
    await ownerPage.getByRole('button', { name: 'Надіслати посилання листом' }).click()
    await ownerPage.getByText('Посилання передано в тестовий поштовий транспорт').waitFor()

    const link = guestUrlFromSealed(addressA)
    const guestPage = await newPage()
    const nickname = await guestAnswers(guestPage, link, owner, addressB, 'DENIED')

    // Код надсилався на B, а не на A.
    expect(mail.sealedTo(addressB)?.body).toMatch(/Код підтвердження: \d{6}/)
    expect(mail.sealedTo(addressA)?.body).not.toMatch(/Код підтвердження/)

    await expectOwnerSees(
      ownerPage,
      confirmationId,
      'гість заперечує',
      'Гість заперечує отримання книжки',
    )

    const rows = await prisma.notification.findMany({
      where: { userId: owner.id, type: { in: ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] } },
      include: { deliveries: true },
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('GUEST_LOAN_DENIED')
    expect(rows[0]?.deliveries.map((d) => d.channel).sort()).toEqual(['EMAIL', 'IN_APP'])

    await expectGenericOwnerMail(
      owner,
      [addressA, addressB],
      [nickname, 'заперечує', 'DENIED', confirmationId],
    )
  })
})
