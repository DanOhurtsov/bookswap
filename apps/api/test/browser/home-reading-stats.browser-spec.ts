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
import { PrismaService } from '../../src/prisma/prisma.service'
import { ReadingStatusService } from '../../src/reading-status/reading-status.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { createShelfCopy, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-145: АВТОМАТИЧНИЙ браузерний e2e статистики читання на головній — НЕ ручне QA. Реальні web
 * (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium, лише
 * синтетичні акаунти. Нічого не підставлено: ні API, ні зовнішніх джерел.
 *
 * Шлях: порожня головна → бібліотека (клавіатурою) → перший «Не читав» на картці → головна → сторінка
 * власної книги → «Прочитано» → головна, усе без перезавантаження; далі повторне відкриття. Окремо: стара
 * адреса `/reading-list`, гість, зміна акаунта в одній вкладці, мобільна ширина у світлій і темній темах,
 * і гонка: перехід на головну, чию статистику сервер прочитав до збереження статусу. Єдине втручання —
 * затримка справжньої відповіді `ReadingStatusService.stats` у цьому процесі, керована тестом.
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

interface Reader extends Account {
  email: string
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

async function registerReader(prefix: string): Promise<Reader> {
  const email = uniqueEmail(prefix)
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: `Читач ${String(Date.now())}` })
    .expect(201)

  return {
    id: (response.body as { user: { id: string } }).user.id,
    cookie: sessionCookie(response.headers),
    displayName: 'Читач',
    email,
  }
}

async function setStatus(account: Account, workId: string, status: string): Promise<void> {
  await request(app.getHttpServer())
    .put(url(`/me/reading-statuses/${workId}`))
    .set('Cookie', account.cookie)
    .send({ status })
    .expect(200)
}

async function titleOf(workId: string): Promise<string> {
  const { title } = await prisma.work.findUniqueOrThrow({
    where: { id: workId },
    select: { title: true },
  })

  return title
}

interface OpenOptions {
  width: number
  theme: (typeof THEMES)[number]
}

async function newPage({ width, theme }: OpenOptions = { width: 1280, theme: 'light' }) {
  const touch = width < 1024
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)

  return context.newPage()
}

/** Logs in through the form; the app then navigates to the home page on its own. */
async function login(page: Page, email: string): Promise<void> {
  if (new URL(page.url()).pathname !== '/login') await page.goto(`${WEB_ORIGIN}/login`)

  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL(`${WEB_ORIGIN}/`)
}

/** Every reading-stats request the page sends, as `METHOD path`. */
function watchStatsRequests(page: Page): string[] {
  const seen: string[] = []

  page.on('request', (sent: Request) => {
    const address = new URL(sent.url())

    if (address.pathname.endsWith('/me/reading-stats'))
      seen.push(`${sent.method()} ${address.pathname}`)
  })

  return seen
}

function statsSection(page: Page): Locator {
  return page.getByRole('region', { name: 'Моє читання' })
}

async function expectCounts(
  page: Page,
  counts: { NOT_READ: number; READING: number; READ: number },
): Promise<void> {
  const labels = { NOT_READ: 'Не читав', READING: 'Читаю', READ: 'Прочитано' } as const

  for (const [status, label] of Object.entries(labels) as [keyof typeof labels, string][]) {
    await statsSection(page)
      .locator('div', { has: page.getByText(label, { exact: true }) })
      .locator('dd', { hasText: new RegExp(`^${String(counts[status])}$`) })
      .waitFor()
  }
}

/** Client-side navigation through the header. */
async function follow(page: Page, link: string, path: string): Promise<void> {
  await page.getByRole('link', { name: link, exact: true }).first().click()
  await page.waitForURL(`${WEB_ORIGIN}${path}`)
}

/** A marker on `window` survives only client-side navigation: proof that nothing reloaded. */
async function markWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { bs145?: boolean }).bs145 = true
  })
}

async function expectSameWindow(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { bs145?: boolean }).bs145 === true)).toBe(
    true,
  )
}

async function choose(page: Page, control: Locator, option: string): Promise<void> {
  await control.click()
  await page.getByRole('listbox').getByRole('option', { name: option }).click()
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.BROWSER_SCREENSHOT_DIR

  if (directory !== undefined)
    await page.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

describe('BS-145: статистика читання на головній (браузер)', () => {
  it('порожня головна → бібліотека → «Не читав» → головна → власна книга → «Прочитано» → головна без перезавантаження', async () => {
    const reader = await registerReader('bs145-flow')
    const shelf = await createShelfCopy(app, reader)
    const title = await titleOf(shelf.workId)
    const page = await newPage()
    const statsRequests = watchStatsRequests(page)

    await login(page, reader.email)
    await page.waitForLoadState('networkidle')

    // Порожній стан, а не три нулі.
    await statsSection(page)
      .getByText(/Ви ще не позначили жодного твору/)
      .waitFor()
    expect(await statsSection(page).locator('dd').count()).toBe(0)

    // Лічильники прочитав сервер — і після входу, і при повному відкритті; браузер їх не перепитує.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await statsSection(page)
      .getByText(/Ви ще не позначили жодного твору/)
      .waitFor()
    expect(statsRequests).toEqual([])

    // Клавіатура: Tab доходить до переходу в бібліотеку, фокус видно, Enter відкриває.
    await markWindow(page)
    const cta = statsSection(page).getByRole('link', { name: 'Перейти до бібліотеки' })
    let focused = false

    for (let step = 0; step < 30 && !focused; step += 1) {
      await page.keyboard.press('Tab')
      focused = await cta.evaluate((element) => element === document.activeElement)
    }

    expect(focused).toBe(true)
    expect(await cta.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none')
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/library`)

    // Перший явний «Не читав» на картці полиці.
    const card = page.getByRole('combobox', { name: `Мій статус читання: «${title}»` })

    await card.waitFor()
    await page.waitForLoadState('networkidle')
    await choose(page, card, 'Не читав')
    await card.filter({ hasText: 'Не читав' }).waitFor()

    await follow(page, 'Головна', '/')
    await expectCounts(page, { NOT_READ: 1, READING: 0, READ: 0 })
    await expectSameWindow(page)

    // Сторінка власної книги.
    await follow(page, 'Моя бібліотека', '/library')
    await page
      .getByRole('link', { name: new RegExp(`^${title}`) })
      .first()
      .click()
    await page.waitForURL(`${WEB_ORIGIN}/library/${shelf.copyId}`)

    const panel = page.getByRole('combobox', { name: 'Мій статус читання', exact: true })

    await panel.filter({ hasText: 'Не читав' }).waitFor()
    await choose(page, panel, 'Прочитано')
    await page.getByText('Збережено: «Прочитано».').waitFor()

    await follow(page, 'Головна', '/')
    await expectCounts(page, { NOT_READ: 0, READING: 0, READ: 1 })
    await expectSameWindow(page)

    // Повторне відкриття: із сервера.
    await page.reload()
    await expectCounts(page, { NOT_READ: 0, READING: 0, READ: 1 })

    expect(
      await prisma.workReadingStatus.findMany({
        where: { userId: reader.id },
        select: { workId: true, status: true },
      }),
    ).toEqual([{ workId: shelf.workId, status: 'READ' }])
  })

  it('стара адреса: сервер відповідає 307 на /library без HTML старого екрана й без параметрів', async () => {
    const response = await fetch(`${WEB_ORIGIN}/reading-list?status=READ&cursor=abc`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '', WEB_ORIGIN).href).toBe(
      `${WEB_ORIGIN}/library`,
    )
    expect(await response.text()).not.toContain('Список читання')

    // Авторизований читач: пряме відкриття закінчується в бібліотеці.
    const reader = await registerReader('bs145-old')
    const page = await newPage()

    await login(page, reader.email)

    const opened = await page.goto(`${WEB_ORIGIN}/reading-list?status=READING&cursor=x`)

    await page.waitForURL(`${WEB_ORIGIN}/library`)
    expect(new URL(page.url()).search).toBe('')
    expect(opened?.request().redirectedFrom()?.url()).toBe(
      `${WEB_ORIGIN}/reading-list?status=READING&cursor=x`,
    )
    await page.getByRole('heading', { name: 'Моя бібліотека', level: 1 }).waitFor()
    expect(await page.getByRole('heading', { name: 'Список читання' }).count()).toBe(0)

    // Гість: спершу бібліотека, далі її звичайний захист.
    const guest = await newPage()

    await guest.goto(`${WEB_ORIGIN}/reading-list`)
    await guest.waitForURL((address) => address.pathname === '/login')
  })

  it('гість: блоку немає, і приватний API статистики не викликає ні браузер, ні сервер', async () => {
    const stats = jest.spyOn(app.get(ReadingStatusService), 'stats')

    try {
      const page = await newPage()
      const statsRequests = watchStatsRequests(page)

      await page.goto(`${WEB_ORIGIN}/`)
      await page.waitForLoadState('networkidle')
      await page.getByRole('heading', { name: 'BookSwap', level: 1 }).waitFor()

      expect(await statsSection(page).count()).toBe(0)
      expect(statsRequests).toEqual([])
      expect(stats).not.toHaveBeenCalled()
    } finally {
      stats.mockRestore()
    }
  })

  it('A → вихід → B у тій самій вкладці: головна B ніколи не показує лічильників A', async () => {
    const a = await registerReader('bs145-a')
    const b = await registerReader('bs145-b')
    const [one, two] = await Promise.all([createShelfCopy(app, a), createShelfCopy(app, a)])

    await setStatus(a, one.workId, 'READ')
    await setStatus(a, two.workId, 'READ')
    await setStatus(b, one.workId, 'READING')

    const page = await newPage()

    // Every text the block ever had, across client navigations.
    await page.addInitScript(() => {
      const frames: string[] = []

      ;(window as unknown as { statsFrames: string[] }).statsFrames = frames
      new MutationObserver(() => {
        const block = document.querySelector('.reading-stats')

        if (block !== null) frames.push(block.textContent ?? '')
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })

    await login(page, a.email)
    await expectCounts(page, { NOT_READ: 0, READING: 0, READ: 2 })
    await screenshot(page, 'bs145-home-1280-light')
    await markWindow(page)

    await page.getByRole('button', { name: /Відкрити меню профілю/ }).click()
    await page.getByRole('menuitem', { name: 'Вийти' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/login`)

    const before = await page.evaluate(
      () => (window as unknown as { statsFrames: string[] }).statsFrames.length,
    )

    await login(page, b.email)
    await expectCounts(page, { NOT_READ: 0, READING: 1, READ: 0 })
    await expectSameWindow(page)

    const framesForB = await page.evaluate(
      (from) => (window as unknown as { statsFrames: string[] }).statsFrames.slice(from),
      before,
    )

    expect(framesForB.filter((frame) => /Прочитано\s*2/.test(frame))).toEqual([])
  })

  it('перехід на головну, чию статистику сервер прочитав до збереження: після переходу — актуальні числа', async () => {
    const reader = await registerReader('bs145-race')
    const shelf = await createShelfCopy(app, reader)
    const title = await titleOf(shelf.workId)

    await setStatus(reader, shelf.workId, 'READING')

    // Signed in by cookie, straight into the library: the home page has never been mounted here.
    const page = await newPage()
    const separator = reader.cookie.indexOf('=')

    await page.context().addCookies([
      {
        name: reader.cookie.slice(0, separator),
        value: reader.cookie.slice(separator + 1),
        url: WEB_ORIGIN,
      },
    ])
    await page.addInitScript(() => {
      const frames: string[] = []

      ;(window as unknown as { statsFrames: string[] }).statsFrames = frames
      new MutationObserver(() => {
        const block = document.querySelector('.reading-stats')

        if (block !== null) frames.push(block.textContent ?? '')
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })

    const statsRequests = watchStatsRequests(page)
    const outcomes: string[] = []

    page.on('requestfinished', (sent) => {
      if (sent.url().endsWith('/me/reading-stats')) outcomes.push('finished')
    })
    page.on('requestfailed', (sent) => {
      if (sent.url().endsWith('/me/reading-stats'))
        outcomes.push(`failed: ${sent.failure()?.errorText ?? ''}`)
    })
    const card = page.getByRole('combobox', { name: `Мій статус читання: «${title}»` })

    await page.goto(`${WEB_ORIGIN}/library`)
    await card.filter({ hasText: 'Читаю' }).waitFor()
    await page.waitForLoadState('networkidle')
    await markWindow(page)

    // The real API answer for the home page is held back: the server reads the counts at once —
    // before the save — and returns them only when the test releases them.
    const service = app.get(ReadingStatusService)
    const original = service.stats.bind(service)
    let markRead: () => void = () => undefined
    let release: () => void = () => undefined
    const read = new Promise<void>((resolve) => {
      markRead = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const stats = jest.spyOn(service, 'stats').mockImplementationOnce(async (userId) => {
      const counts = await original(userId)

      markRead()
      await released

      return counts
    })

    try {
      await page.getByRole('link', { name: 'Головна', exact: true }).first().click()
      await read
      expect(new URL(page.url()).pathname).toBe('/library')

      // While the library is still on screen, the status changes and the PUT succeeds.
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/me/reading-statuses/${shelf.workId}`) &&
          response.ok(),
      )

      await choose(page, card, 'Прочитано')
      await saved
      await card.filter({ hasText: 'Прочитано' }).waitFor()
      expect(new URL(page.url()).pathname).toBe('/library')
      expect(statsRequests).toEqual([])

      release()
      await page.waitForURL(`${WEB_ORIGIN}/`)
      await expectCounts(page, { NOT_READ: 0, READING: 0, READ: 1 })
      await expectSameWindow(page)
    } finally {
      release()
      stats.mockRestore()
    }

    // The held snapshot never became the counts: the browser read them again, once. `next dev` runs
    // React in strict mode, which mounts the block twice; the first mount's read is aborted with it.
    expect(new Set(statsRequests)).toEqual(new Set(['GET /api/v1/me/reading-stats']))
    expect(outcomes.filter((outcome) => outcome === 'finished')).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome !== 'finished')).toEqual(
      Array.from({ length: outcomes.length - 1 }, () => 'failed: net::ERR_ABORTED'),
    )
    expect(
      (
        await page.evaluate(() => (window as unknown as { statsFrames: string[] }).statsFrames)
      ).filter((frame) => /Читаю\s*1/.test(frame)),
    ).toEqual([])
    expect(
      await prisma.workReadingStatus.findMany({
        where: { userId: reader.id },
        select: { status: true },
      }),
    ).toEqual([{ status: 'READ' }])
  })

  for (const theme of THEMES) {
    it(`мобільна ширина 375 px, ${theme} тема: без горизонтального скролу, плитки в межах блоку, читабельний текст`, async () => {
      const reader = await registerReader(`bs145-m-${theme}`)
      const works = await Promise.all([createShelfCopy(app, reader), createShelfCopy(app, reader)])

      await setStatus(reader, works[0].workId, 'READING')
      await setStatus(reader, works[1].workId, 'READ')

      const page = await newPage({ width: 375, theme })

      await login(page, reader.email)
      await expectCounts(page, { NOT_READ: 0, READING: 1, READ: 1 })
      await screenshot(page, `bs145-home-375-${theme}`)

      const geometry = await page.evaluate(() => {
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

        const block = document.querySelector('.reading-stats')
        const box = block?.getBoundingClientRect()
        const tiles = [...document.querySelectorAll('.reading-stats__item')]
        const texts = [...document.querySelectorAll('.reading-stats dt, .reading-stats dd')]

        return {
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
          pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          tiles: tiles.length,
          tilesOutside: tiles.filter((tile) => {
            const own = tile.getBoundingClientRect()

            return box === undefined || own.left < box.left || own.right > box.right + 0.5
          }).length,
          minContrast: Math.min(...texts.map(contrast)),
        }
      })

      expect(geometry.theme).toBe(theme)
      expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
      expect(geometry.tiles).toBe(3)
      expect(geometry.tilesOutside).toBe(0)
      expect(geometry.minContrast).toBeGreaterThanOrEqual(4.5)
    })
  }
})
