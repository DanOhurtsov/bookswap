import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import {
  befriend,
  createShelfCopy,
  handedOverLoan,
  registerAccount,
  url,
  type Account,
} from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * Stage 10, 10j.2: АВТОМАТИЧНИЙ браузерний e2e основного шляху особистого статусу читання — НЕ ручне QA.
 * Реальні web (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium,
 * лише синтетичні акаунти з `uniqueEmail`; жодної пошти поза локальним `DevEmailSender` (browser-env.ts).
 *
 * Шлях: читач ставить «Прочитано» на сторінці твору → бачить твір (з тегом «Була позичена») в особистому
 * списку, відкритому з навігації → змінює статус на «Читаю» → список і фільтри показують оновлення. Окремо:
 * власник примірника на тій самій сторінці твору не бачить статусу читача (R-8).
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser`. Без Chromium тест ПАДАЄ (не пропускається).
 */

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let prisma: PrismaService
const contexts: BrowserContext[] = []

beforeAll(async () => {
  app = await createTestApp()
  prisma = app.get(PrismaService)
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
}, 240_000)

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

interface Reader extends Account {
  email: string
}

async function registerReader(): Promise<Reader> {
  const email = uniqueEmail('br-reader')
  const displayName = `Читач ${String(process.pid)}-${String(Date.now())}`
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName })
    .expect(201)

  return {
    id: (response.body as { user: { id: string } }).user.id,
    cookie: sessionCookie(response.headers),
    displayName,
    email,
  }
}

async function newPage(): Promise<Page> {
  const context = await browser.newContext()

  contexts.push(context)

  return context.newPage()
}

async function settle(page: Page): Promise<void> {
  // Кнопки працюють лише після гідрації: клік до неї — дія в нікуди.
  await page.waitForLoadState('networkidle')
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/login`)
  await settle(page)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL((address) => !address.pathname.startsWith('/login'))
}

function statusControl(page: Page): Locator {
  return page.getByRole('group', { name: 'Мій статус читання' })
}

async function openWork(page: Page, workId: string): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/works/${workId}`)
  await statusControl(page).waitFor()
  await settle(page)
}

async function setStatus(page: Page, label: 'Читаю' | 'Прочитано'): Promise<void> {
  await statusControl(page).getByRole('button', { name: label }).click()
  await page.getByText(`Збережено: «${label}».`).waitFor()
}

async function expectPressed(page: Page, label: string): Promise<void> {
  await statusControl(page).getByRole('button', { name: label, pressed: true }).waitFor()
}

function listRow(page: Page, title: string): Locator {
  return page.locator('li.book').filter({ has: page.getByRole('link', { name: title }) })
}

async function chooseFilter(page: Page, label: 'Усі' | 'Читаю' | 'Прочитано'): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Фільтр списку читання' })
    .getByRole('button', { name: label })
    .click()
  await page
    .getByRole('navigation', { name: 'Фільтр списку читання' })
    .getByRole('button', { name: label, pressed: true })
    .waitFor()
}

describe('Stage 10 (10j.2): браузерний шлях особистого статусу читання', () => {
  it('READ на сторінці твору → приватний список → зміна на READING → оновлений список', async () => {
    const owner = await registerAccount(app, 'br-owner')
    const reader = await registerReader()

    await befriend(app, owner, reader)

    const shelf = await createShelfCopy(app, owner)
    const { title } = await prisma.work.findUniqueOrThrow({
      where: { id: shelf.workId },
      select: { title: true },
    })

    // Фактична передача — підстава тега «Була позичена» (R-5); статус вона НЕ ставить (R-3).
    await handedOverLoan(app, owner, reader, shelf.copyId)

    const page = await newPage()

    await login(page, reader.email)
    await openWork(page, shelf.workId)

    // Q16: розділ передач перейменовано; блок власників лишився.
    await page.getByRole('heading', { name: 'Хто брав цю книжку' }).waitFor()
    await page.getByRole('heading', { name: 'Хто має цю книжку?' }).waitFor()
    expect(await page.getByText('Хто з друзів це читав').count()).toBe(0)

    await expectPressed(page, 'Не читав')
    await page.getByText('Була позичена').waitFor()

    await setStatus(page, 'Прочитано')
    await expectPressed(page, 'Прочитано')

    // Повторне зчитування з сервера, а не лише локальний стан.
    await page.reload()
    await statusControl(page).waitFor()
    await expectPressed(page, 'Прочитано')

    // Особистий список — з навігації (меню профілю).
    await settle(page)
    await page.getByRole('button', { name: /Відкрити меню профілю/ }).click()
    await page.getByRole('menuitem', { name: 'Список читання' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/reading-list`)
    await page.getByRole('heading', { name: 'Список читання' }).waitFor()
    await settle(page)

    const row = listRow(page, title)

    await row.getByText('Прочитано', { exact: true }).waitFor()
    await row.getByText('Була позичена').waitFor()

    await chooseFilter(page, 'Читаю')
    await page.getByText('Зараз ви нічого не читаєте.').waitFor()
    await chooseFilter(page, 'Прочитано')
    await listRow(page, title).waitFor()

    // Зміна статусу: з рядка списку назад на сторінку твору.
    await listRow(page, title).getByRole('link', { name: title }).click()
    await page.waitForURL(`${WEB_ORIGIN}/works/${shelf.workId}`)
    await statusControl(page).waitFor()
    await settle(page)
    await setStatus(page, 'Читаю')
    await expectPressed(page, 'Читаю')

    await page.goto(`${WEB_ORIGIN}/reading-list`)
    await settle(page)
    await listRow(page, title).getByText('Читаю', { exact: true }).waitFor()
    await listRow(page, title).getByText('Була позичена').waitFor()

    await chooseFilter(page, 'Прочитано')
    await page.getByText('Прочитаних творів поки немає.').waitFor()
    await chooseFilter(page, 'Читаю')
    await listRow(page, title).waitFor()

    const stored = await prisma.workReadingStatus.findMany({
      where: { userId: reader.id },
      select: { workId: true, status: true },
    })

    expect(stored).toEqual([{ workId: shelf.workId, status: 'READING' }])

    // R-8: власник позиченого примірника бачить лише СВІЙ статус («Не читав»), не статус читача.
    const ownerPage = await newPage()
    const ownerEmail = await prisma.user.findUniqueOrThrow({
      where: { id: owner.id },
      select: { email: true },
    })

    await login(ownerPage, ownerEmail.email)
    await openWork(ownerPage, shelf.workId)
    await expectPressed(ownerPage, 'Не читав')

    const history = ownerPage.locator('section').filter({
      has: ownerPage.getByRole('heading', { name: 'Хто брав цю книжку' }),
    })

    await history.getByText(reader.displayName, { exact: false }).first().waitFor()
    expect(await history.getByText(/Читаю|Прочитано/).count()).toBe(0)
  })
})
