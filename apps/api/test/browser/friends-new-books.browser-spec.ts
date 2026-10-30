import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Request,
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { FriendsNewBooksService } from '../../src/library/friends-new-books.service'
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { befriend, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-147: АВТОМАТИЧНИЙ браузерний e2e секції «Нове в бібліотеках друзів» на головній. Реальні web
 * (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium, синтетичні
 * акаунти, дружби й книжки, створені через API. Відповіді продуктового API не підмінено.
 *
 * Підстановки, і лише такі:
 * - обкладинки — вигаданий хост `covers.bs147.test`, запити до якого обслуговує сам браузер (PNG 1×1);
 * - час додавання книжки (`Copy.createdAt`) виставляється в БД, щоб порядок не залежав від швидкості
 *   запитів;
 * - сценарій помилки: запити стрічки браузер обриває на рівні мережі (`route.abort`), повтор іде до
 *   справжнього API; сценарій завантаження затримує справжній запит у браузері, не змінюючи відповіді.
 *
 * Секція замінила «Що читають мої друзі» (BS-137): її браузерний сценарій пішов разом із нею з головної,
 * а API BS-137 і його e2e лишилися (рішення PO від 30.10.2026).
 *
 * `BROWSER_SCREENSHOT_DIR` (необовʼязково) — куди покласти знімки для ручного перегляду.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser`. Без Chromium тест ПАДАЄ (не пропускається).
 */

const THEMES = ['light', 'dark'] as const
const SECTION = 'Нове в бібліотеках друзів'
const SHORT_HEADING = 'Нове в друзів'
const FEED_PATH = '/api/v1/me/friends/new-books'
const COVER_HOST = 'https://covers.bs147.test'
const DAY_MS = 24 * 60 * 60 * 1000
/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let app: INestApplication<App>
let prisma: PrismaService
let browser: Browser
let web: ChildProcess | undefined
let sequence = 0
const contexts: BrowserContext[] = []

interface Reader extends Account {
  email: string
}

interface Book {
  workId: string
  copyId: string
  title: string
}

interface Feed {
  viewer: Reader
  friends: Reader[]
  /** In the order of the feed: newest first. */
  books: Book[]
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

async function registerReader(prefix: string, name: string): Promise<Reader> {
  sequence += 1

  const email = uniqueEmail(prefix)
  const displayName = `${name} ${String(sequence)}`
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

/** A work, its edition and a copy of it on `owner`'s shelf, added `daysAgo` days back. */
async function addBook(
  owner: Reader,
  title: string,
  daysAgo: number,
  cover = false,
): Promise<Book> {
  sequence += 1

  const server = app.getHttpServer()
  const work = await request(server)
    .post(url('/works'))
    .set('Cookie', owner.cookie)
    .send({ title, origLang: 'uk', authors: [{ name: `Авторка ${String(sequence)}` }] })
    .expect(201)
  const workId = (work.body as { work: { id: string } }).work.id
  const edition = await request(server)
    .post(url(`/works/${workId}/editions`))
    .set('Cookie', owner.cookie)
    .send({
      publisher: 'Стрічка',
      year: 2024,
      ...(cover ? { coverUrl: `${COVER_HOST}/${workId}.png` } : {}),
    })
    .expect(201)
  const editionId = (edition.body as { edition: { id: string } }).edition.id
  const copy = await request(server)
    .post(url('/me/library'))
    .set('Cookie', owner.cookie)
    .send({ editionId, visibility: 'FRIENDS' })
    .expect(201)
  const copyId = (copy.body as { copy: { id: string } }).copy.id

  await prisma.copy.update({
    where: { id: copyId },
    data: { createdAt: new Date(Date.now() - daysAgo * DAY_MS - 60 * 60 * 1000) },
  })

  return { workId, copyId, title }
}

/** A viewer with four friends who have added `count` books, one a day, every other one with a cover. */
async function feedOf(prefix: string, count: number): Promise<Feed> {
  const viewer = await registerReader(`${prefix}-v`, 'Глядачка')
  const friends = [
    await registerReader(`${prefix}-1`, 'Марта'),
    await registerReader(`${prefix}-2`, 'Олесь'),
    await registerReader(`${prefix}-3`, 'Ярина'),
    await registerReader(`${prefix}-4`, 'Тарас'),
  ]

  for (const friend of friends) await befriend(app, viewer, friend)

  const books: Book[] = []

  for (let index = 0; index < count; index += 1) {
    const title =
      index === 1
        ? `Дуже довга назва книжки, що не вміщається в рядок ${String(index)}`
        : `Книжка ${String(index + 1)} ${prefix}`

    books.push(await addBook(friends[index % friends.length]!, title, index + 1, index % 2 === 0))
  }

  return { viewer, friends, books }
}

async function newPage(
  width = 1440,
  theme: (typeof THEMES)[number] = 'light',
  options: BrowserContextOptions = {},
): Promise<Page> {
  const touch = width < 1024
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
    ...options,
  })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)
  await context.route(`${COVER_HOST}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  )

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

/** Every feed request the page sends, as `METHOD path?query`. */
function watchFeedRequests(page: Page): string[] {
  const seen: string[] = []

  page.on('request', (sent: Request) => {
    const address = new URL(sent.url())

    if (address.pathname === FEED_PATH)
      seen.push(`${sent.method()} ${address.pathname}${address.search}`)
  })

  return seen
}

function section(page: Page): Locator {
  return page.getByRole('region', { name: SECTION })
}

function cards(page: Page): Locator {
  return section(page).getByRole('group')
}

async function ready(page: Page): Promise<void> {
  await cards(page).first().waitFor()
  await page.waitForLoadState('networkidle')
}

async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.BROWSER_SCREENSHOT_DIR

  if (directory !== undefined)
    await page.screenshot({
      path: join(directory, `${name}.png`),
      fullPage: true,
      animations: 'disabled',
    })
}

/** Where the rail is and which cards are in it, as laid out. */
async function railOf(page: Page) {
  return page.evaluate(() => {
    const viewport = document.querySelector('[data-slot="carousel-content"]')
    const box = viewport?.getBoundingClientRect()
    const region = viewport?.closest('[aria-roledescription="карусель"]')?.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    const links = [...document.querySelectorAll('[data-slot="carousel-item"] a')]
    const covers = links.map((link) => link.querySelector('.shelf-cover')!.getBoundingClientRect())
    const inView = (cover: DOMRect) =>
      box !== undefined && cover.left >= box.left - 0.5 && cover.right <= box.right + 0.5

    return {
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // How far the clipping viewport reaches past the section on each side, and whether it reaches
      // the screen's edges.
      bleed:
        box === undefined || region === undefined
          ? null
          : {
              left: Math.round(region.left - box.left),
              right: Math.round(box.right - region.right),
            },
      toEdges: box !== undefined && Math.round(box.left) === 0 && Math.round(box.right) === width,
      cardWidths: [...new Set(links.map((link) => Math.round(link.getBoundingClientRect().width)))],
      coverBoxes: [
        ...new Set(
          covers.map(
            (cover) => `${String(Math.round(cover.width))}x${String(Math.round(cover.height))}`,
          ),
        ),
      ],
      fullyInView: covers.filter(inView).length,
      firstInView: covers.findIndex(inView),
      lastInView: covers.length - 1 - [...covers].reverse().findIndex(inView),
      // Any descendant that runs past its card and is not clipped on the way: a title or a name that
      // neither wrapped nor truncated. A truncated line's own box still reaches past; its text does not.
      overflowingCards: links.filter((link) => {
        const card = link.getBoundingClientRect()
        const clipped = (element: Element): boolean => {
          for (let up = element.parentElement; up !== null && up !== link; up = up.parentElement)
            if (getComputedStyle(up).overflowX !== 'visible') return true

          return false
        }

        return [...link.querySelectorAll('*')].some(
          (child) => child.getBoundingClientRect().right > card.right + 0.5 && !clipped(child),
        )
      }).length,
    }
  })
}

/** Waits until the rail stops moving: Embla animates in JS, so `animations: 'disabled'` does not apply. */
async function settled(page: Page): Promise<void> {
  let last = ''

  for (let step = 0; step < 40; step += 1) {
    const now = await page.evaluate(
      () =>
        document.querySelector('[data-slot="carousel-content"] > div')?.getAttribute('style') ?? '',
    )

    if (now === last) return
    last = now
    await page.waitForTimeout(100)
  }
}

describe('BS-147: «Нове в бібліотеках друзів» на головній (браузер)', () => {
  it('гість: секції немає, і приватний API стрічки не викликає ні браузер, ні сервер', async () => {
    const spy = jest.spyOn(app.get(FriendsNewBooksService), 'list')

    try {
      const page = await newPage()
      const feedRequests = watchFeedRequests(page)

      await page.goto(`${WEB_ORIGIN}/`)
      await page.getByRole('heading', { name: 'BookSwap', level: 1 }).waitFor()
      await page.waitForLoadState('networkidle')

      expect(await section(page).count()).toBe(0)
      expect(await page.getByText(SECTION).count()).toBe(0)
      expect(feedRequests).toEqual([])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('порожньо: рядок макета з «Запросити», що з клавіатури веде на сторінку друзів; на телефоні — короткий заголовок', async () => {
    const viewer = await registerReader('bs147-alone', 'Самітниця')
    const page = await newPage(390)

    await login(page, viewer.email)
    await section(page).getByText('Друзі ще нічого не додали').waitFor()
    expect(
      await section(page).getByText('Запросіть більше друзів, щоб бачити нові книжки.').count(),
    ).toBe(1)
    expect(await page.getByText(SHORT_HEADING, { exact: true }).isVisible()).toBe(true)
    await screenshot(page, 'bs147-empty-390-light')

    const link = section(page).getByRole('link', { name: 'Запросити' })

    await link.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/friends`)
  })

  it('завантаження, помилка з role="alert" і повтор, що приносить справжні картки', async () => {
    const { viewer } = await feedOf('bs147-err', 3)
    const page = await newPage()
    const feedRequests = watchFeedRequests(page)
    let release: () => void = () => undefined
    // Until the error is on screen every read fails at the network level: in `next dev` StrictMode
    // mounts the section twice and cancels the first read, so «every request until the error shows» is
    // the stable target.
    let failing = true

    await page.route(`**${FEED_PATH}*`, async (route) => {
      if (failing) {
        await route.abort('failed').catch(() => undefined)

        return
      }

      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.continue()
    })

    await login(page, viewer.email)

    const alert = section(page).getByRole('alert')

    await alert.waitFor()

    // No retry on its own: nothing more is sent while the error is shown.
    const sent = feedRequests.length

    await page.waitForTimeout(1500)
    expect(feedRequests).toHaveLength(sent)
    failing = false
    expect(await alert.textContent()).toContain('Не вдалося завантажити нові книжки друзів.')
    await screenshot(page, 'bs147-error-1440-light')

    const retry = alert.getByRole('button', { name: 'Спробувати ще раз' })

    await retry.focus()
    await page.keyboard.press('Enter')

    await section(page).getByText('Шукаю нові книжки друзів…').waitFor({ state: 'attached' })
    expect(await section(page).getAttribute('aria-busy')).toBe('true')
    await screenshot(page, 'bs147-loading-1440-light')
    release()

    await cards(page).first().waitFor()
    expect(await cards(page).count()).toBe(3)
    expect(await section(page).getByRole('alert').count()).toBe(0)
    expect(feedRequests).toHaveLength(sent + 1)
    expect(new Set(feedRequests)).toEqual(new Set([`GET ${FEED_PATH}`]))
  })

  // Six cards in view on a desktop (canvas: `(100% − 100px) / 6` of the 1120 px container), 140 px cards
  // with arrows on a tablet, 116 px cards without arrows on a phone; below a desktop the rail runs to the
  // screen's edges.
  const LAYOUTS = [
    { width: 1440, card: 170, cover: '170x255', inView: 6, arrows: true, toEdges: false, bleed: 8 },
    { width: 834, card: 140, cover: '140x210', inView: 5, arrows: true, toEdges: true, bleed: 24 },
    { width: 390, card: 116, cover: '116x174', inView: 2, arrows: false, toEdges: true, bleed: 16 },
  ] as const

  for (const theme of THEMES) {
    it(`рейка на 1440/834/390, ${theme} тема: ширини карток, стрілки, без горизонтального скролу; «Що читають мої друзі» більше немає`, async () => {
      const { viewer, friends, books } = await feedOf(`bs147-rail-${theme}`, 12)

      // Reading something no longer puts a second friends' section on the home page.
      await request(app.getHttpServer())
        .put(url(`/me/reading-statuses/${books[0]!.workId}`))
        .set('Cookie', friends[0]!.cookie)
        .send({ status: 'READING' })
        .expect(200)

      for (const layout of LAYOUTS) {
        const page = await newPage(layout.width, theme)

        await login(page, viewer.email)
        await ready(page)
        await screenshot(page, `bs147-ready-${String(layout.width)}-${theme}`)

        const rail = await railOf(page)

        expect({ width: layout.width, ...rail }).toMatchObject({
          width: layout.width,
          pageOverflow: 0,
          bleed: { left: layout.bleed, right: layout.bleed },
          toEdges: layout.toEdges,
          cardWidths: [layout.card],
          coverBoxes: [layout.cover],
          fullyInView: layout.inView,
          firstInView: 0,
          overflowingCards: 0,
        })
        expect(await cards(page).count()).toBe(12)
        expect(
          await section(page).getByRole('button', { name: 'Наступні книжки' }).isVisible(),
        ).toBe(layout.arrows)
        expect(await page.getByText(SHORT_HEADING, { exact: true }).isVisible()).toBe(
          layout.width < 768,
        )
        expect(await page.getByRole('heading', { name: 'Що читають мої друзі' }).count()).toBe(0)
      }

      // The cards: newest first, each one link named by the title, the author, the friend and when.
      const page = await newPage(1440, theme)

      await login(page, viewer.email)
      await ready(page)

      const first = cards(page).first()
      const link = first.getByRole('link')

      expect(await first.getByRole('link').count()).toBe(1)
      expect(await link.getAttribute('href')).toBe(`/works/${books[0]!.workId}`)
      expect(await link.getAttribute('aria-label')).toMatch(
        new RegExp(`^${books[0]!.title}, Авторка \\d+\\. Додано: ${friends[0]!.displayName}, `),
      )
      expect(await first.locator('time').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(await first.locator('img').count()).toBe(1)
      expect(await cards(page).nth(1).locator('[data-slot="drawn-cover"]').count()).toBe(1)
    })
  }

  it('стрілки й клавіатура: сторінка вперед і назад, краї вимикають стрілку, Tab показує фокус і гортає до картки, Enter відкриває твір', async () => {
    const { viewer, books } = await feedOf('bs147-keys', 12)
    const page = await newPage(1440, 'dark')

    await login(page, viewer.email)
    await ready(page)

    const previous = section(page).getByRole('button', { name: 'Попередні книжки' })
    const next = section(page).getByRole('button', { name: 'Наступні книжки' })

    expect(await previous.isDisabled()).toBe(true)
    expect(await next.isEnabled()).toBe(true)
    expect(await next.getAttribute('aria-controls')).toBe(
      await page.locator('[data-slot="carousel-content"] > div').getAttribute('id'),
    )

    await next.click()
    await settled(page)
    expect(await railOf(page)).toMatchObject({ firstInView: 6, lastInView: 11 })
    expect(await next.isDisabled()).toBe(true)
    expect(await previous.isEnabled()).toBe(true)
    await screenshot(page, 'bs147-end-1440-dark')

    await previous.click()
    await settled(page)
    expect(await railOf(page)).toMatchObject({ firstInView: 0, lastInView: 5 })

    // Real Tab presses from the top of the page: a programmatic focus would not be `:focus-visible`.
    const firstHref = `/works/${books[0]!.workId}`

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })

    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab')

      if ((await page.evaluate(() => document.activeElement?.getAttribute('href'))) === firstHref)
        break
    }

    const focus = () =>
      page.evaluate(() => {
        const active = document.activeElement
        const cover = active?.querySelector('.shelf-cover')
        const style = cover === null || cover === undefined ? null : getComputedStyle(cover)

        return {
          href: active?.getAttribute('href') ?? '',
          outline: style === null ? 'none' : `${style.outlineStyle} ${style.outlineWidth}`,
        }
      })

    expect(await focus()).toEqual({ href: firstHref, outline: 'solid 2px' })
    await screenshot(page, 'bs147-focus-1440-dark')

    // Tab past the sixth card: the seventh is scrolled into view.
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('Tab')
    await settled(page)
    expect((await focus()).href).toBe(`/works/${books[6]!.workId}`)
    expect((await railOf(page)).firstInView).toBeGreaterThan(0)
    expect((await railOf(page)).lastInView).toBeGreaterThanOrEqual(6)

    // ← from inside the carousel goes back a page.
    await page.keyboard.press('ArrowLeft')
    await settled(page)
    expect((await railOf(page)).firstInView).toBe(0)

    await cards(page).nth(2).getByRole('link').focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/works/${books[2]!.workId}`)
    await page.getByRole('heading', { name: books[2]!.title, level: 1 }).waitFor()
  })

  it('мало карток — нічого гортати: стрілок немає', async () => {
    const { viewer } = await feedOf('bs147-few', 3)
    const page = await newPage(1440)

    await login(page, viewer.email)
    await ready(page)
    await page.waitForTimeout(500)

    expect(await cards(page).count()).toBe(3)
    expect(await section(page).getByRole('button').count()).toBe(0)
    expect(await railOf(page)).toMatchObject({ fullyInView: 3, pageOverflow: 0 })
    await screenshot(page, 'bs147-few-1440-light')
  })

  it('prefers-reduced-motion: стрілка перескакує одразу, без анімації', async () => {
    const { viewer } = await feedOf('bs147-motion', 12)
    const page = await newPage(1440, 'light', { reducedMotion: 'reduce' })

    await login(page, viewer.email)
    await ready(page)
    await section(page).getByRole('button', { name: 'Наступні книжки' }).click()
    // One frame later the move is already done.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    )

    expect(await railOf(page)).toMatchObject({ firstInView: 6 })
  })

  it('свайп на телефоні гортає рейку; сторінка не прокручується вбік', async () => {
    const { viewer } = await feedOf('bs147-swipe', 12)
    const page = await newPage(390)

    await login(page, viewer.email)
    await ready(page)

    const box = (await cards(page).first().boundingBox())!
    const y = box.y + box.height / 3
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
      })

    await touch('touchStart', 300)
    for (let x = 290; x >= 40; x -= 25) await touch('touchMove', x)
    await touch('touchEnd', 40)
    await settled(page)

    const rail = await railOf(page)

    expect(rail.firstInView).toBeGreaterThan(0)
    expect(rail.pageOverflow).toBe(0)
    expect(await page.evaluate(() => window.scrollX)).toBe(0)
  })

  it('текст 200 %: без горизонтального скролу, картки й назви в межах', async () => {
    const { viewer } = await feedOf('bs147-zoom', 12)
    const page = await newPage(1440, 'light')

    await login(page, viewer.email)
    await ready(page)
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
    await page.waitForLoadState('networkidle')
    await screenshot(page, 'bs147-text200-1440-light')

    const rail = await railOf(page)

    expect(rail.pageOverflow).toBeLessThanOrEqual(0)
    expect(rail.overflowingCards).toBe(0)
  })

  it('A → вихід → B у тій самій вкладці: B ніколи не бачить стрічки A', async () => {
    const a = await feedOf('bs147-switch', 4)
    const b = await registerReader('bs147-switch-b', 'Інша людина')
    const page = await newPage()

    await page.addInitScript(() => {
      const frames: string[] = []

      ;(window as unknown as { feedFrames: string[] }).feedFrames = frames
      new MutationObserver(() => {
        frames.push(document.querySelector('main')?.textContent ?? '')
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })

    await login(page, a.viewer.email)
    await ready(page)

    await page.getByRole('button', { name: /Відкрити меню профілю/ }).click()
    await page.getByRole('menuitem', { name: 'Вийти' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/login`)

    const before = await page.evaluate(
      () => (window as unknown as { feedFrames: string[] }).feedFrames.length,
    )

    await login(page, b.email)
    await section(page).getByText('Друзі ще нічого не додали').waitFor()

    const framesForB = await page.evaluate(
      (from) => (window as unknown as { feedFrames: string[] }).feedFrames.slice(from),
      before,
    )
    const titlesOfA = a.books.map((book) => book.title)

    expect(framesForB.filter((frame) => titlesOfA.some((title) => frame.includes(title)))).toEqual(
      [],
    )
  })
})
