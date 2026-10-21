import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { MergeService } from '../../src/catalog/merge/merge.service'
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { createShelfCopy, url, type Account, type Shelf } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-140: АВТОМАТИЧНИЙ браузерний e2e керування статусом читання на полиці та сторінці власної книги.
 * Реальні web (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium,
 * лише синтетичні акаунти. Нічого не підставлено: ні API, ні зовнішніх джерел.
 *
 * Полиця власника: твір A у двох виданнях (у першому два примірники) і твір B. Шлях: зміна на картці →
 * друга картка того самого твору → сторінка власної книги → зміна там → повернення на полицю → повторне
 * відкриття. Окремо: злиття A → B справжнім `MergeService` при відкритій полиці, клавіатура й фокус, що
 * dropdown не відкриває книгу, мобільна ширина у світлій і темній темах.
 *
 * `BROWSER_SCREENSHOT_DIR` (необовʼязково) — куди покласти знімки для ручного перегляду.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser`. Без Chromium тест ПАДАЄ (не пропускається).
 */

const THEMES = ['light', 'dark'] as const

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let prisma: PrismaService
const contexts: BrowserContext[] = []

interface Owner extends Account {
  email: string
}

interface Library {
  owner: Owner
  a: { title: string; workId: string; firstCopyId: string }
  b: { title: string; workId: string }
}

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

async function registerOwner(): Promise<Owner> {
  const email = uniqueEmail('bs140-owner')
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: `Власник ${String(Date.now())}` })
    .expect(201)

  return {
    id: (response.body as { user: { id: string } }).user.id,
    cookie: sessionCookie(response.headers),
    displayName: 'Власник',
    email,
  }
}

async function addCopy(owner: Account, editionId: string): Promise<void> {
  await request(app.getHttpServer())
    .post(url('/me/library'))
    .set('Cookie', owner.cookie)
    .send({ editionId, visibility: 'FRIENDS' })
    .expect(201)
}

async function setStatus(owner: Account, workId: string, status: string): Promise<void> {
  await request(app.getHttpServer())
    .put(url(`/me/reading-statuses/${workId}`))
    .set('Cookie', owner.cookie)
    .send({ status })
    .expect(200)
}

async function titleOf(shelf: Shelf): Promise<string> {
  const { title } = await prisma.work.findUniqueOrThrow({
    where: { id: shelf.workId },
    select: { title: true },
  })

  return title
}

/** A in two editions (the first with two copies), B in one. */
async function buildLibrary(): Promise<Library> {
  const owner = await registerOwner()
  const a = await createShelfCopy(app, owner)

  await addCopy(owner, a.editionId)

  const second = await request(app.getHttpServer())
    .post(url(`/works/${a.workId}/editions`))
    .set('Cookie', owner.cookie)
    .send({ publisher: 'Друге видавництво', year: 2021 })
    .expect(201)

  await addCopy(owner, (second.body as { edition: { id: string } }).edition.id)

  const b = await createShelfCopy(app, owner)

  return {
    owner,
    a: { title: await titleOf(a), workId: a.workId, firstCopyId: a.copyId },
    b: { title: await titleOf(b), workId: b.workId },
  }
}

interface OpenOptions {
  width: number
  theme: (typeof THEMES)[number]
}

async function signedInPage(owner: Owner, { width, theme }: OpenOptions): Promise<Page> {
  const touch = width < 1024
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)

  const page = await context.newPage()

  await page.goto(`${WEB_ORIGIN}/login`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(owner.email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL((address) => !address.pathname.startsWith('/login'))

  return page
}

/** Every reading-status request the page sends, as `METHOD path?query`. */
function watchStatusRequests(page: Page): string[] {
  const seen: string[] = []

  page.on('request', (sent: Request) => {
    const address = new URL(sent.url())

    if (address.pathname.includes('/me/reading-statuses'))
      seen.push(`${sent.method()} ${address.pathname}${address.search}`)
  })

  return seen
}

async function openLibrary(page: Page): Promise<void> {
  await page.goto(`${WEB_ORIGIN}/library`)
  await page
    .getByRole('combobox', { name: /^Мій статус читання: «/ })
    .first()
    .waitFor()
  await page.waitForLoadState('networkidle')
}

function cardControls(page: Page, title: string): Locator {
  return page.getByRole('combobox', { name: `Мій статус читання: «${title}»` })
}

function cardWith(page: Page, text: string): Locator {
  return page.locator('li.book').filter({ hasText: text })
}

function pagePanel(page: Page): Locator {
  return page.getByRole('combobox', { name: 'Мій статус читання', exact: true })
}

async function expectText(control: Locator, text: string): Promise<void> {
  await control.filter({ hasText: text }).waitFor()
}

async function choose(page: Page, control: Locator, option: string): Promise<void> {
  await control.click()
  // The list that is open now: the one closed by the previous choice can linger in the DOM a moment.
  await page.getByRole('listbox').getByRole('option', { name: option }).click()
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.BROWSER_SCREENSHOT_DIR

  // Finished, not mid-fade: a popup caught in its opening animation looks see-through.
  if (directory !== undefined)
    await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

describe('BS-140: статус читання на полиці та на сторінці власної книги (браузер)', () => {
  it('полиця → зміна → друга картка твору → власна книга → зміна → повернення → повторне відкриття', async () => {
    const library = await buildLibrary()
    const page = await signedInPage(library.owner, { width: 1280, theme: 'light' })
    const statusRequests = watchStatusRequests(page)

    await openLibrary(page)

    // Один пакетний запит на всю полицю, а не по запиту на картку.
    expect(statusRequests).toHaveLength(1)
    expect(statusRequests[0]).toMatch(/^GET \/api\/v1\/me\/reading-statuses\?workIds=/)
    expect(new Set(statusRequests[0]?.split('workIds=')[1]?.split(','))).toEqual(
      new Set([library.a.workId, library.b.workId]),
    )

    const aControls = cardControls(page, library.a.title)

    expect(await aControls.count()).toBe(2)
    expect(await cardControls(page, library.b.title).count()).toBe(1)
    await expectText(aControls.first(), 'Вказати статус читання')

    // Зміна на картці другого видання — видно й на картці першого; книга не відкрилась.
    await choose(page, cardWith(page, 'Друге видавництво').getByRole('combobox'), 'Читаю')
    await expectText(aControls.nth(0), 'Читаю')
    await expectText(aControls.nth(1), 'Читаю')
    await expectText(cardControls(page, library.b.title), 'Вказати статус читання')
    expect(new URL(page.url()).pathname).toBe('/library')

    // Картка веде на сторінку першого примірника; статус там той самий, без нового запиту.
    const before = statusRequests.length

    await page.getByRole('link', { name: new RegExp(`^${library.a.title} ×2`) }).click()
    await page.waitForURL(`${WEB_ORIGIN}/library/${library.a.firstCopyId}`)
    await expectText(pagePanel(page), 'Читаю')
    expect(statusRequests.slice(before).filter((sent) => sent.startsWith('GET'))).toEqual([])

    await choose(page, pagePanel(page), 'Прочитано')
    await page.getByText('Збережено: «Прочитано».').waitFor()

    // Повернення без перезавантаження: обидві картки твору вже знають.
    await page.getByRole('link', { name: '← До моєї бібліотеки' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/library`)
    await expectText(aControls.nth(0), 'Прочитано')
    await expectText(aControls.nth(1), 'Прочитано')

    // Повторне відкриття: статус із сервера.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expectText(cardControls(page, library.a.title).nth(0), 'Прочитано')
    await expectText(cardControls(page, library.a.title).nth(1), 'Прочитано')

    await page.goto(`${WEB_ORIGIN}/works/${library.a.workId}`)
    await expectText(pagePanel(page), 'Прочитано')

    const rows = await prisma.workReadingStatus.findMany({
      where: { userId: library.owner.id },
      select: { workId: true, status: true },
    })

    expect(rows).toEqual([{ workId: library.a.workId, status: 'READ' }])
    expect(statusRequests.filter((sent) => sent.startsWith('PUT'))).toHaveLength(2)
  })

  it('твір A злито в B, поки полиця відкрита: після пакетного перечитування зміна на будь-якій картці видна на всіх, запис іде за канонічним ID', async () => {
    const library = await buildLibrary()

    await setStatus(library.owner, library.a.workId, 'READING')
    await setStatus(library.owner, library.b.workId, 'READING')

    const page = await signedInPage(library.owner, { width: 1280, theme: 'light' })
    const statusRequests = watchStatusRequests(page)

    await openLibrary(page)

    const aControls = cardControls(page, library.a.title)
    const bControl = cardControls(page, library.b.title)

    await expectText(aControls.nth(0), 'Читаю')
    await expectText(aControls.nth(1), 'Читаю')
    await expectText(bControl, 'Читаю')

    // Справжнє злиття, полиця лишається відкритою з картками A.
    await new MergeService(prisma).merge(library.a.workId, library.b.workId)

    // Перечитування без перезавантаження: статуси, старші за 30 с, вкладка перечитує, коли знову стає
    // видимою. Час справжній: підмінений годинник сторінки (`page.clock`) заважає Select закритися.
    await page.waitForTimeout(31_000)

    const reread = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/me/reading-statuses'),
    )

    await page.evaluate(() => {
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    })

    const { items } = (await (await reread).json()) as {
      items: { requestedWorkId: string; workId: string; status: string }[]
    }

    // Пакет уже називає B канонічним для A.
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestedWorkId: library.a.workId,
          workId: library.b.workId,
          status: 'READING',
        }),
        expect.objectContaining({ requestedWorkId: library.b.workId, workId: library.b.workId }),
      ]),
    )

    await choose(page, bControl, 'Прочитано')
    await expectText(bControl, 'Прочитано')
    await expectText(aControls.nth(0), 'Прочитано')
    await expectText(aControls.nth(1), 'Прочитано')
    // Збереження спільне: доки воно триває, картки A теж заблоковані. Наступний вибір — як у людини:
    // коли збережено й список закрився, повернувши фокус на свій контрол.
    await page
      .locator('li.book')
      .filter({ has: bControl })
      .getByRole('status')
      .filter({ hasText: 'Збережено' })
      .waitFor()
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await bControl.elementHandle(),
    )

    // І навпаки: картка A зберігає за вже відомим канонічним ID, без 409.
    await choose(page, aControls.nth(1), 'Не читав')
    await expectText(bControl, 'Не читав')
    await expectText(aControls.nth(0), 'Не читав')
    expect(await page.locator('li.book').getByRole('alert').count()).toBe(0)
    expect(new URL(page.url()).pathname).toBe('/library')

    expect(statusRequests.filter((sent) => sent.startsWith('PUT'))).toEqual([
      `PUT /api/v1/me/reading-statuses/${library.b.workId}`,
      `PUT /api/v1/me/reading-statuses/${library.b.workId}`,
    ])

    const rows = await prisma.workReadingStatus.findMany({
      where: { userId: library.owner.id },
      select: { workId: true, status: true },
    })

    expect(rows).toEqual([{ workId: library.b.workId, status: 'NOT_READ' }])
  })

  it('клавіатура: Tab доходить до контролу, фокус видно, вибір Enter; підпис і порожнє місце рядка книгу не відкривають', async () => {
    const library = await buildLibrary()
    const page = await signedInPage(library.owner, { width: 1280, theme: 'light' })

    await openLibrary(page)

    const card = cardWith(page, library.b.title)
    const trigger = card.getByRole('combobox')

    // Рядок статусу: підпис і порожнє місце праворуч від контролу.
    await card.getByText('Читання', { exact: true }).click()
    const box = await card.locator('.reading-status').boundingBox()

    expect(box).not.toBeNull()
    await page.mouse.click(box!.x + box!.width - 4, box!.y + box!.height / 2)
    expect(new URL(page.url()).pathname).toBe('/library')

    // Справжній порядок Tab від посилання картки до її контролу.
    await card.getByRole('link', { name: new RegExp(`^${library.b.title}`) }).focus()

    let reached = false

    for (let step = 0; step < 12 && !reached; step += 1) {
      await page.keyboard.press('Tab')
      reached = await trigger.evaluate((element) => element === document.activeElement)
    }

    expect(reached).toBe(true)
    expect(await trigger.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe(
      'none',
    )

    // Escape закриває список без змін і повертає фокус.
    await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('listbox').waitFor({ state: 'hidden' })
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true)

    await page.keyboard.press('ArrowDown')
    await page.getByRole('listbox').waitFor()

    const target = page.getByRole('option', { name: 'Прочитано' })

    for (let step = 0; step < 4; step += 1) {
      if ((await target.getAttribute('data-highlighted')) !== null) break
      await page.keyboard.press('ArrowDown')
    }
    await page.keyboard.press('Enter')

    await expectText(trigger, 'Прочитано')
    await card.getByRole('status').filter({ hasText: 'Збережено' }).waitFor()
    await page.waitForFunction(
      (element) => element === document.activeElement,
      await trigger.elementHandle(),
    )
    expect(new URL(page.url()).pathname).toBe('/library')

    // Звичайна частина картки — досі посилання на книгу: клік туди, де лише текст видання під шаром
    // посилання (Playwright-клік по самому тексту відмовився б — його перекриває посилання).
    const text = await card.getByText(/КСД/).boundingBox()

    expect(text).not.toBeNull()
    await page.mouse.click(text!.x + 2, text!.y + text!.height / 2)
    await page.waitForURL((address) => address.pathname.startsWith('/library/'))
  })

  for (const theme of THEMES) {
    it(`мобільна ширина 375 px, ${theme} тема: рядок у межах картки, без горизонтального скролу, список у вʼюпорті, читабельний текст`, async () => {
      const library = await buildLibrary()
      const page = await signedInPage(library.owner, { width: 375, theme })

      await openLibrary(page)
      await screenshot(page, `bs140-library-375-${theme}`)

      const geometry = await page.evaluate(() => {
        // Any CSS colour (oklch included) to sRGB, through the browser's own parser.
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d', { willReadFrequently: true })

        function rgb(color: string): [number, number, number, number] {
          if (context === null) return [0, 0, 0, 0]
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data

          return [r, g, b, a]
        }

        function background(element: Element | null): [number, number, number, number] {
          for (let node = element; node !== null; node = node.parentElement) {
            const color = rgb(getComputedStyle(node).backgroundColor)

            if (color[3] > 0) return color
          }

          return rgb(getComputedStyle(document.body).backgroundColor)
        }

        function luminance([r, g, b]: [number, number, number, number]): number {
          const channel = (value: number): number => {
            const s = value / 255

            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          }

          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        }

        function contrast(element: Element): number {
          const one = luminance(rgb(getComputedStyle(element).color))
          const two = luminance(background(element))

          return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
        }

        const rows = [...document.querySelectorAll('.reading-status--card')]

        return {
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rowsOutsideCard: rows.filter((row) => {
            const card = row.closest('li.book')?.getBoundingClientRect()
            const box = row.getBoundingClientRect()

            return card === undefined || box.left < card.left || box.right > card.right + 0.5
          }).length,
          rows: rows.length,
          triggerContrast: Math.min(
            ...rows.map((row) =>
              contrast(row.querySelector('[data-slot="select-trigger"]') ?? row),
            ),
          ),
          labelContrast: Math.min(
            ...rows.map((row) => contrast(row.querySelector('label') ?? row)),
          ),
        }
      })

      expect(geometry.theme).toBe(theme)
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
      expect(geometry.rows).toBe(3)
      expect(geometry.rowsOutsideCard).toBe(0)
      expect(geometry.triggerContrast).toBeGreaterThanOrEqual(4.5)
      expect(geometry.labelContrast).toBeGreaterThanOrEqual(4.5)

      const trigger = cardControls(page, library.b.title)

      await trigger.tap()

      const listbox = page.getByRole('listbox')

      await listbox.waitFor()
      await screenshot(page, `bs140-library-375-${theme}-open`)

      const list = await listbox.boundingBox()

      expect(list).not.toBeNull()
      expect(list!.x).toBeGreaterThanOrEqual(0)
      expect(list!.x + list!.width).toBeLessThanOrEqual(375)

      await page.getByRole('option', { name: 'Не читав' }).tap()
      await expectText(trigger, 'Не читав')
      expect(new URL(page.url()).pathname).toBe('/library')

      // BS-140, рішення 4: явний «Не читав» без попереднього запису — це запис.
      const row = await prisma.workReadingStatus.findUnique({
        where: { userId_workId: { userId: library.owner.id, workId: library.b.workId } },
        select: { status: true },
      })

      expect(row).toEqual({ status: 'NOT_READ' })
    })
  }
})
