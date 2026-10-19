import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { EXTERNAL_SEARCH_PROVIDERS } from '../../src/catalog/search/external/external-search-provider'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { FakeExternalSearchProvider } from '../lookup/fake-external-search-provider'
import { befriend, registerAccount, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-134: search results of `/catalog` and `/catalog/new` as a grid of 1–4 columns by the width of the
 * list, the page controls under it, and the pages ahead loaded in the background
 * (docs/plan/bs-134-search-grid-pagination.md).
 *
 * Geometry is the subject, so this runs in a real Chromium against the real web (`next dev`) and API
 * (`createTestApp` in this process) over the test database. Stand-ins: the external title search
 * sources are in-process fakes that find nothing (no call to Open Library or Google Books), and the
 * cover images live on a made-up host whose requests the browser answers itself — one with a real
 * PNG, one with a 404 (a broken cover).
 *
 * Run: `pnpm --filter @bookswap/api test:browser -- search-grid`. Without Chromium the test FAILS.
 */

const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1920] as const
const THEMES = ['light', 'dark'] as const
/** Columns at the default 16px root font: thresholds 37.5 / 57.5 / 77.5 rem of the list's width. */
const EXPECTED_COLUMNS: Record<(typeof WIDTHS)[number], number> = {
  320: 1,
  390: 1,
  768: 2,
  1024: 3,
  1280: 3,
  1440: 4,
  1920: 4,
}

const COVER_HOST = 'https://covers.bs134.test'
const GOOD_COVER = `${COVER_HOST}/good.png`
const BROKEN_COVER = `${COVER_HOST}/broken.png`
/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/**
 * The paging set: more books than one page of the default 12 holds, so page 2 exists and is proven;
 * fewer than one page of 24, which shows them all on one page.
 */
const BOOKS = 14
/** A full page of the default size. */
const FULL = DEFAULT_SEARCH_PAGE_SIZE
/** The hard cases, found by their own query: one row of up to 4 cards. */
const HARD_BOOKS = 4

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let viewer: { email: string; account: Account }
/** Finds the paging set only. */
let token: string
/** Finds the hard cases only — no shared letters with `token`, so neither search finds the other set. */
let hardToken: string
const contexts: BrowserContext[] = []

beforeAll(async () => {
  app = await createTestApp({
    configure: (builder) => {
      builder
        .overrideProvider(EXTERNAL_SEARCH_PROVIDERS)
        .useValue([
          new FakeExternalSearchProvider('OPEN_LIBRARY'),
          new FakeExternalSearchProvider('GOOGLE_BOOKS'),
        ])
    },
  })
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()

  const stamp = Date.now().toString(36)

  token = `storinky${stamp}`
  hardToken = `qwxz${stamp.split('').reverse().join('')}`
  viewer = await registerViewer()

  const owner = await registerAccount(app, 'br-grid-owner')

  await befriend(app, owner, viewer.account)

  for (let index = 0; index < BOOKS; index += 1) {
    await createBook(owner, { title: `${token} книжка ${String(index)}`, author: 'Автор' })
  }

  const unbroken = 'Ж'.repeat(100)

  await createBook(owner, {
    title: `${hardToken} надзвичайно довга назва книжки про сітку результатів, яка мусить переноситися на кілька рядків і ніколи не розширювати колонку`,
    author: 'Автор із дуже довгим іменем і ще довшим прізвищем, що мусить переноситися',
    coverUrl: GOOD_COVER,
  })
  await createBook(owner, {
    title: `${hardToken} ${unbroken}`,
    author: `Автор${unbroken}`,
    publisher: `Видавництво${unbroken}`,
    coverUrl: BROKEN_COVER,
  })
  await createBook(owner, { title: `${hardToken} без обкладинки`, author: 'Автор' })
  await createBook(owner, { title: `${hardToken} ще одна`, author: 'Автор' })
}, 300_000)

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

async function registerViewer(): Promise<{ email: string; account: Account }> {
  const email = uniqueEmail('br-grid')
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: 'Перевірка сітки' })
    .expect(201)

  return {
    email,
    account: {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
      displayName: 'Перевірка сітки',
    },
  }
}

/** One work with one edition and a copy of the owner's, visible to friends. */
async function createBook(
  owner: Account,
  book: { title: string; author: string; publisher?: string; coverUrl?: string },
): Promise<void> {
  const work = await request(app.getHttpServer())
    .post(url('/works'))
    .set('Cookie', owner.cookie)
    .send({ title: book.title, origLang: 'uk', authors: [{ name: book.author }] })
    .expect(201)
  const workId = (work.body as { work: { id: string } }).work.id
  const created = await request(app.getHttpServer())
    .post(url(`/works/${workId}/editions`))
    .set('Cookie', owner.cookie)
    .send({
      publisher: book.publisher ?? 'Видавництво',
      year: 2024,
      ...(book.coverUrl === undefined ? {} : { coverUrl: book.coverUrl }),
    })
    .expect(201)
  const editionId = (created.body as { edition: { id: string } }).edition.id

  await request(app.getHttpServer())
    .post(url('/me/library'))
    .set('Cookie', owner.cookie)
    .send({ editionId, visibility: 'FRIENDS' })
    .expect(201)
}

/** A signed-in context in `theme`: the covers' host is answered here, never on the network. */
async function signedIn(theme: (typeof THEMES)[number], width = 1440): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 } })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)
  await context.route(`${COVER_HOST}/**`, (route) =>
    route.request().url() === GOOD_COVER
      ? route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      : route.fulfill({ status: 404, body: '' }),
  )

  const page = await context.newPage()

  await page.goto(`${WEB_ORIGIN}/login`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(viewer.email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL((address) => !address.pathname.startsWith('/login'))

  return page
}

interface Grid {
  viewport: number
  rootFont: number
  theme: string
  pageOverflow: number
  listWidth: number
  /** Computed track count of the result grid. */
  columns: number
  /** Distinct left edges of the cards: the columns as laid out. */
  laidOutColumns: number
  /** Distinct top edges of the cards: the rows as laid out. */
  laidOutRows: number
  cards: number
  /** Cards, or anything inside one, sticking out of the card or the list. */
  overflowing: string[]
  /** Every cover box (image or placeholder) on the page, as `width×height`. */
  coverBoxes: string[]
  placeholders: number
  loadedImages: number
}

function grid(page: Page): Promise<Grid> {
  return page.evaluate((): Grid => {
    const list = document.querySelector('.result-grid > ul')

    if (list === null) throw new Error('No result grid')

    const listRect = list.getBoundingClientRect()
    const cards = [...list.querySelectorAll<HTMLElement>(":scope > li[data-slot='result-card']")]
    const overflowing: string[] = []

    for (const card of cards) {
      const rect = card.getBoundingClientRect()

      if (rect.left < listRect.left - 0.5 || rect.right > listRect.right + 0.5) {
        overflowing.push(`card: ${(card.textContent ?? '').slice(0, 40)}`)
      }
      if (card.scrollWidth > card.clientWidth) {
        overflowing.push(`scroll: ${(card.textContent ?? '').slice(0, 40)}`)
      }

      for (const inner of card.querySelectorAll('*')) {
        const box = inner.getBoundingClientRect()

        if (box.width > 0 && (box.left < rect.left - 0.5 || box.right > rect.right + 0.5)) {
          overflowing.push(`inside: ${(inner.textContent ?? inner.tagName).slice(0, 40)}`)
        }
      }
    }

    const covers = [
      ...list.querySelectorAll<HTMLElement>(
        "[data-slot='book-cover'], [data-slot='book-cover-placeholder']",
      ),
    ]

    return {
      viewport: document.documentElement.clientWidth,
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      listWidth: listRect.width,
      columns: getComputedStyle(list).gridTemplateColumns.split(' ').length,
      laidOutColumns: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)))
        .size,
      laidOutRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      cards: cards.length,
      overflowing,
      coverBoxes: covers.map((cover) => {
        const box = cover.getBoundingClientRect()

        return `${String(Math.round(box.width))}×${String(Math.round(box.height))}`
      }),
      placeholders: list.querySelectorAll("[data-slot='book-cover-placeholder']").length,
      loadedImages: [
        ...list.querySelectorAll<HTMLImageElement>("img[data-slot='book-cover']"),
      ].filter((image) => image.complete && image.naturalWidth > 0).length,
    }
  })
}

/** Columns the thresholds give for a list this wide. */
function columnsFor(listWidth: number, rootFont: number): number {
  if (listWidth >= 77.5 * rootFont) return 4
  if (listWidth >= 57.5 * rootFont) return 3

  return listWidth >= 37.5 * rootFont ? 2 : 1
}

async function showResults(page: Page, path: string, cards: number = FULL): Promise<Grid> {
  await page.goto(`${WEB_ORIGIN}${path}`)
  await page
    .locator(".result-grid li[data-slot='result-card']")
    .nth(cards - 1)
    .waitFor()
  // The broken cover has answered (404) and been replaced by the placeholder.
  await page.waitForLoadState('networkidle')

  return grid(page)
}

function expectSoundGrid(
  found: Grid,
  expected: { width: (typeof WIDTHS)[number]; theme: string; cards: number },
): void {
  expect(found.theme).toBe(expected.theme)
  expect(found.viewport).toBe(expected.width)
  expect(found.pageOverflow).toBe(0)
  expect(found.cards).toBe(expected.cards)
  expect(found.columns).toBe(EXPECTED_COLUMNS[expected.width])
  expect(found.columns).toBe(columnsFor(found.listWidth, found.rootFont))
  expect(found.laidOutColumns).toBe(Math.min(found.columns, found.cards))
  expect(found.laidOutRows).toBe(Math.ceil(found.cards / found.columns))
  expect(found.overflowing).toEqual([])
  // One box for every cover: the picture, the missing one and the broken one alike — the vertical card's
  // (docs/plan/vertical-search-cards.md).
  expect(new Set(found.coverBoxes)).toEqual(new Set(['128×192']))
}

/** Requests the browser made for one page of the add-book search's local half. */
function trackPages(page: Page): number[] {
  const pages: number[] = []

  page.on('request', (sent) => {
    const address = new URL(sent.url())

    if (address.pathname.endsWith('/me/library/add-search')) {
      pages.push(Number(address.searchParams.get('page')))
    }
  })

  return pages
}

describe('BS-134: search results grid and paging', () => {
  for (const theme of THEMES) {
    it(`both routes at every width keep the grid, the covers and the page width, ${theme} theme`, async () => {
      const page = await signedIn(theme)

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })

        for (const route of ['/catalog/new', '/catalog']) {
          const paged = await showResults(page, `${route}?q=${token}`)

          expectSoundGrid(paged, { width, theme, cards: FULL })
          // The default 12 fills whole rows at every column count: 4×3 in the 1440 px container.
          if (width === 1440) expect([paged.columns, paged.laidOutRows]).toEqual([4, 3])

          const hard = await showResults(page, `${route}?q=${hardToken}`, HARD_BOOKS)

          expectSoundGrid(hard, { width, theme, cards: HARD_BOOKS })
          // The good cover is a picture; the broken one and the missing ones are the placeholder.
          expect(hard.loadedImages).toBe(1)
          expect(hard.placeholders).toBe(HARD_BOOKS - 1)

          await screenshot(
            page,
            `${route === '/catalog' ? 'catalog' : 'catalog-new'}-${String(width)}-${theme}`,
          )
        }
      }
    })
  }

  it('typing runs the full search: the grid and the page controls at once, no «Показати всі результати»', async () => {
    const page = await signedIn('light')
    const asked = trackPages(page)

    await page.goto(`${WEB_ORIGIN}/catalog/new`)
    await page.getByLabel('Назва, автор або ISBN').fill(token)
    await page
      .locator(".result-grid li[data-slot='result-card']")
      .nth(FULL - 1)
      .waitFor()

    expect(new URL(page.url()).searchParams.get('q')).toBe(token)
    expect(new URL(page.url()).searchParams.has('auto')).toBe(false)
    await expect(
      page.getByRole('button', { name: 'Показати всі результати' }).count(),
    ).resolves.toBe(0)
    await page.getByRole('navigation', { name: 'Сторінки результатів' }).waitFor()
    // Page 2 is loaded ahead in the background (page 3 is not: page 2 is the last).
    await waitUntil(() => asked.includes(2))
    expect(asked.filter((number) => number === 1)).toHaveLength(1)
    expect(asked.includes(3)).toBe(false)
  })

  it('an old suggestions link (auto=1) opens the full search and drops the flag', async () => {
    const page = await signedIn('dark')

    await page.goto(`${WEB_ORIGIN}/catalog/new?q=${token}&auto=1`)
    await page
      .locator(".result-grid li[data-slot='result-card']")
      .nth(FULL - 1)
      .waitFor()
    await page.waitForURL((address) => !address.searchParams.has('auto'))
    await page.getByRole('navigation', { name: 'Сторінки результатів' }).waitFor()
  })

  for (const theme of THEMES) {
    it(`keyboard: Tab reaches page 2, Enter opens the prepared page, aria-current follows, Back returns, ${theme} theme`, async () => {
      const page = await signedIn(theme)
      const asked = trackPages(page)

      await showResults(page, `/catalog/new?q=${token}`)
      await waitUntil(() => asked.includes(2))

      const second = page.getByRole('link', { name: 'Сторінка 2' })

      await page.locator('body').focus()

      for (let step = 0; step < 120; step += 1) {
        await page.keyboard.press('Tab')

        if (await second.evaluate((element) => element === document.activeElement)) break
      }

      const ring = await second.evaluate((element) => {
        const style = getComputedStyle(element)

        return style.outlineStyle !== 'none' || style.boxShadow !== 'none'
      })

      expect(ring).toBe(true)

      const before = asked.filter((number) => number === 2).length

      await page.keyboard.press('Enter')
      await page.waitForURL((address) => address.searchParams.get('page') === '2')
      await page.getByRole('link', { name: 'Сторінка 2, поточна' }).waitFor()

      await expect(
        page.getByRole('link', { name: 'Сторінка 2, поточна' }).getAttribute('aria-current'),
      ).resolves.toBe('page')
      await expect(page.locator(".result-grid li[data-slot='result-card']").count()).resolves.toBe(
        BOOKS - FULL,
      )
      // The prepared page was used: no second request for it.
      expect(asked.filter((number) => number === 2)).toHaveLength(before)

      await page.goBack()
      await page.waitForURL((address) => !address.searchParams.has('page'))
      await page.getByRole('link', { name: 'Сторінка 1, поточна' }).waitFor()
      expect((await grid(page)).pageOverflow).toBe(0)
    })
  }

  for (const route of ['/catalog/new', '/catalog']) {
    it(`${route}: an old pageSize=10 address becomes page 1 of 12; 24 holds the whole set on one page`, async () => {
      const page = await signedIn('dark', 390)

      await page.goto(`${WEB_ORIGIN}${route}?q=${token}&page=2&pageSize=10`)
      await page.waitForURL(
        (address) => !address.searchParams.has('pageSize') && !address.searchParams.has('page'),
      )
      await page
        .locator(".result-grid li[data-slot='result-card']")
        .nth(FULL - 1)
        .waitFor()
      await page.getByRole('link', { name: 'Сторінка 2' }).waitFor()

      expect(new URL(page.url()).searchParams.get('q')).toBe(token)
      await expect(page.locator(".result-grid li[data-slot='result-card']").count()).resolves.toBe(
        FULL,
      )

      const whole = await showResults(page, `${route}?q=${token}&pageSize=24`, BOOKS)

      expect(whole.cards).toBe(BOOKS)
      expect(whole.pageOverflow).toBe(0)
      // One page: no page navigation, the size selector stays.
      await expect(
        page.getByRole('navigation', { name: 'Сторінки результатів' }).count(),
      ).resolves.toBe(0)
      await expect(
        page.getByRole('combobox', { name: 'Результатів на сторінці' }).textContent(),
      ).resolves.toContain('24')
    })
  }

  for (const [route, endpoints, kept] of [
    ['/catalog/new', ['/me/library/add-search', '/me/library/add-search/external'], 'keep=1'],
    ['/catalog', ['/catalog/discover'], 'availability=ANY'],
  ] as const) {
    it(`${route}: an old deep link is never asked for — every request is page 1 of 12 or a page ahead of it`, async () => {
      const page = await signedIn('light', 1024)
      const asked: { endpoint: string; address: URLSearchParams }[] = []

      page.on('request', (sent) => {
        const address = new URL(sent.url())
        const endpoint = endpoints.find((path) => address.pathname.endsWith(path))

        if (endpoint !== undefined) asked.push({ endpoint, address: address.searchParams })
      })

      await page.goto(`${WEB_ORIGIN}${route}?q=${token}&page=3&pageSize=10&${kept}`)
      await page.waitForURL(`${WEB_ORIGIN}${route}?q=${token}&${kept}`)
      await page
        .locator(".result-grid li[data-slot='result-card']")
        .nth(FULL - 1)
        .waitFor()
      // 14 books at 12 a page: page 2 is the last one, loaded ahead for every endpoint.
      await waitUntil(() =>
        endpoints.every((endpoint) =>
          asked.some((one) => one.endpoint === endpoint && one.address.get('page') === '2'),
        ),
      )
      // Anything still to come (a late page 3, a repeat after the `replace`) would show up by now.
      await new Promise((resolve) => setTimeout(resolve, 1_000))

      for (const endpoint of endpoints) {
        // Pages in the order they were first asked. A repeat of page 1 is not the old address: the
        // dev server's React Strict Mode mounts twice, cancelling and re-sending the first request on
        // a canonical address exactly the same way.
        const pages = [
          ...new Set(
            asked.filter((one) => one.endpoint === endpoint).map((one) => one.address.get('page')),
          ),
        ]

        expect({ endpoint, pages }).toEqual({ endpoint, pages: ['1', '2'] })
      }
      for (const { address } of asked) {
        expect(address.get('q')).toBe(token)
        expect(address.get('pageSize')).toBe(String(FULL))
        if (route === '/catalog') expect(address.get('availability')).toBe('ANY')
      }
    })
  }

  it('/catalog: page links keep the query and the filters; the page changes, the filters stay', async () => {
    const page = await signedIn('dark', 1024)

    await showResults(page, `/catalog?q=${token}&availability=ANY`)

    const second = page.getByRole('link', { name: 'Сторінка 2' })
    const href = new URL((await second.getAttribute('href')) ?? '', WEB_ORIGIN)

    expect(href.searchParams.get('q')).toBe(token)
    expect(href.searchParams.get('availability')).toBe('ANY')

    await second.click()
    await page.waitForURL((address) => address.searchParams.get('page') === '2')
    await page.getByRole('link', { name: 'Сторінка 2, поточна' }).waitFor()

    expect(new URL(page.url()).searchParams.get('availability')).toBe('ANY')
    await expect(
      page.getByRole('combobox', { name: 'Доступність' }).textContent(),
    ).resolves.toContain('Разом із позиченими')
    expect((await grid(page)).pageOverflow).toBe(0)
  })
})

/** Screenshots for a person to look at, only when `BS134_SCREENSHOTS` names a directory. */
async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.BS134_SCREENSHOTS

  if (directory !== undefined)
    await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true })
}

async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!check()) {
    if (Date.now() > deadline) throw new Error('Умова не справдилася вчасно')

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
