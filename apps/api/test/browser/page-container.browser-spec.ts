import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { EXTERNAL_SEARCH_PROVIDERS } from '../../src/catalog/search/external/external-search-provider'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { FakeExternalSearchProvider } from '../lookup/fake-external-search-provider'
import { befriend, registerAccount, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-133: one page geometry for the header and every page — at most 1440 CSS px wide INCLUDING the
 * gutters at any root font size, centred, the header's content edges on the page's content edges,
 * narrow forms (their width also gutters included) centred inside it, and no horizontal page scroll
 * at any width.
 *
 * Geometry is the subject, so this runs in a real Chromium against the real web (`next dev`) and API
 * (`createTestApp` in this process) over the test database. The only stand-ins: the external title
 * search sources are in-process fakes that find nothing (no outbound call to Open Library or Google
 * Books), and two header states are produced by holding or failing `GET /auth/session` in the browser.
 *
 * Run: `pnpm --filter @bookswap/api test:browser`. Without Chromium the test FAILS (is not skipped).
 */

const WIDTHS = [320, 390, 768, 1024, 1280, 1440, 1600, 1920, 2560] as const
const THEMES = ['light', 'dark'] as const

const MAX_WIDTH = 1440
/** Outer form widths in rem: 448 px and 672 px at the default 16 px root font. */
const NARROW_MEASURE = 28
const MEDIUM_MEASURE = 42
/** Sub-pixel rounding between two boxes laid out from the same values. */
const EPSILON = 0.5

/**
 * A long title of ordinary words: it must wrap inside its card, never widen the page. Not one unbroken
 * 100-letter word — that overflows a `.book` card at any container width, which is not this task's
 * geometry (reported in docs/plan/bs-133-page-container.md).
 */
const LONG_TITLE =
  'надзвичайно довга назва книжки про контейнери, відступи й адаптивну верстку, яка мусить ' +
  'переноситися на кілька рядків у картці й ніколи не розширювати сторінку'

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let viewer: { email: string; account: Account }
let token: string
let edition: { workId: string; editionId: string }
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

  // Short and distinctive: the search finds exactly these books, and the token itself fits 320 px.
  token = `bs133${Date.now().toString(36)}`
  viewer = await registerViewer()

  const owner = await registerAccount(app, 'br-container-owner')

  await befriend(app, owner, viewer.account)
  // A friend's copy for «Доступні від друзів», the viewer's own one for the shelf and add search.
  await createLongTitleCopy(owner)
  edition = await createLongTitleCopy(viewer.account)
}, 240_000)

// Each test's pages are closed when it ends: left open to `afterAll`, the contexts of every width and
// theme pile up in one Chromium for the whole file.
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined)
})

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

async function registerViewer(): Promise<{ email: string; account: Account }> {
  const email = uniqueEmail('br-container')
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: 'Перевірка контейнера' })
    .expect(201)

  return {
    email,
    account: {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
      displayName: 'Перевірка контейнера',
    },
  }
}

async function createLongTitleCopy(
  account: Account,
): Promise<{ workId: string; editionId: string }> {
  const work = await request(app.getHttpServer())
    .post(url('/works'))
    .set('Cookie', account.cookie)
    .send({
      title: `${token} ${LONG_TITLE}`,
      origLang: 'uk',
      authors: [{ name: `Автор ${token}` }],
    })
    .expect(201)
  const workId = (work.body as { work: { id: string } }).work.id
  const created = await request(app.getHttpServer())
    .post(url(`/works/${workId}/editions`))
    .set('Cookie', account.cookie)
    .send({ publisher: 'Видавництво з дуже довгою назвою без скорочень', year: 2024 })
    .expect(201)
  const editionId = (created.body as { edition: { id: string } }).edition.id

  await request(app.getHttpServer())
    .post(url('/me/library'))
    .set('Cookie', account.cookie)
    .send({ editionId, visibility: 'FRIENDS' })
    .expect(201)

  return { workId, editionId }
}

async function openContext(
  width: number,
  theme: (typeof THEMES)[number],
  signedIn: boolean,
  fontSize?: number,
): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 900 } })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)

  const page = await context.newPage()

  // The browser's own default font size, as a reader sets it: it moves rem AND rem media queries.
  if (fontSize !== undefined) await setDefaultFontSize(page, fontSize)

  if (signedIn) {
    await page.goto(`${WEB_ORIGIN}/login`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('Email').fill(viewer.email)
    await page.getByLabel('Пароль').fill(VALID_PASSWORD)
    await page.getByRole('button', { name: 'Увійти' }).click()
    await page.waitForURL((address) => !address.pathname.startsWith('/login'))
  }

  return page
}

/**
 * Chromium's default font-size preference for this page (CDP); 16 px is the browser default. The
 * override lives as long as its session, so the session stays attached until the context closes.
 */
async function setDefaultFontSize(page: Page, standard: number): Promise<void> {
  const session = await page.context().newCDPSession(page)

  await session.send('Page.setFontSizes', { fontSizes: { standard } })
}

interface Box {
  left: number
  right: number
  width: number
  /** The edges of the content box: the border box minus the horizontal padding. */
  contentLeft: number
  contentRight: number
  paddingLeft: number
  paddingRight: number
}

interface Geometry {
  viewport: number
  /** The computed root font size: what 1rem resolves to on this page. */
  rootFont: number
  pageOverflow: number
  theme: string
  mains: number
  header: Box
  headerScrollOverflow: number
  main: Box
  /** Cards, list rows and fields that stick out of the main's content box. */
  sticking: string[]
}

function geometry(page: Page): Promise<Geometry> {
  return page.evaluate((): Geometry => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      const paddingLeft = parseFloat(style.paddingLeft)
      const paddingRight = parseFloat(style.paddingRight)

      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        contentLeft: rect.left + paddingLeft,
        contentRight: rect.right - paddingRight,
        paddingLeft,
        paddingRight,
      }
    }
    const header = document.querySelector('[aria-label="Основні дії"] > .page-container')
    const main = document.querySelector('main')

    if (header === null || main === null) throw new Error('No header container or no main')

    const mainBox = box(main)
    const sticking = [...main.querySelectorAll('li, input, [data-slot="select-trigger"]')]
      // A wide table scrolls inside its own frame (`.matrix-scroll`): its cells may run past the edge.
      .filter((element) => element.closest('.matrix-scroll') === null)
      // Base UI's form inputs behind a select: visually hidden, never laid out with the page.
      .filter((element) => element.closest('[aria-hidden="true"]') === null)
      .filter((element) => {
        const rect = element.getBoundingClientRect()

        return (
          rect.width > 0 &&
          (rect.left < mainBox.contentLeft - 0.5 || rect.right > mainBox.contentRight + 0.5)
        )
      })
      .map((element) => (element.textContent ?? element.tagName).slice(0, 60))

    return {
      viewport: document.documentElement.clientWidth,
      rootFont: parseFloat(getComputedStyle(document.documentElement).fontSize),
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      mains: document.querySelectorAll('main').length,
      header: box(header),
      headerScrollOverflow: header.scrollWidth - header.clientWidth,
      main: mainBox,
      sticking,
    }
  })
}

/**
 * 1rem up to a 30rem-wide window, 1.5rem past it: 16/24 px at the default font. The pages here move
 * the font through the browser preference, so the media query's rem is the root font as well.
 */
function expectedGutter(viewport: number, rootFont: number): number {
  return viewport <= 30 * rootFont ? rootFont : 1.5 * rootFont
}

/** The shared container: full width up to 1440 px with the gutters inside, equal margins past it. */
function expectSharedContainer(box: Box, found: Geometry): void {
  const width = Math.min(found.viewport, MAX_WIDTH)
  const gutter = expectedGutter(found.viewport, found.rootFont)

  expect(box.width).toBeLessThanOrEqual(MAX_WIDTH)
  expect(Math.abs(box.width - width)).toBeLessThan(EPSILON)
  expect(Math.abs(box.left - (found.viewport - box.right))).toBeLessThan(EPSILON)
  expect(box.paddingLeft).toBe(gutter)
  expect(box.paddingRight).toBe(gutter)
}

function expectPageBasics(found: Geometry, theme: string): void {
  expect(found.theme).toBe(theme)
  expect(found.mains).toBe(1)
  expect(found.pageOverflow).toBe(0)
  expect(found.headerScrollOverflow).toBeLessThanOrEqual(0)
  expect(found.sticking).toEqual([])
  expectSharedContainer(found.header, found)
}

/** A standard page: the same box as the header, so the content edges match exactly. */
function expectWidePage(found: Geometry, theme: string): void {
  expectPageBasics(found, theme)
  expectSharedContainer(found.main, found)
  expect(Math.abs(found.main.contentLeft - found.header.contentLeft)).toBeLessThan(EPSILON)
  expect(Math.abs(found.main.contentRight - found.header.contentRight)).toBeLessThan(EPSILON)
}

/**
 * A form: its own outer width (`measure` rem, gutters included), the shared gutters inside it,
 * centred in the shared container and never outside the header's edges.
 */
function expectMeasuredPage(found: Geometry, theme: string, measure: number): void {
  expectPageBasics(found, theme)

  const container = Math.min(found.viewport, MAX_WIDTH)
  const outer = Math.min(measure * found.rootFont, container)
  const gutter = expectedGutter(found.viewport, found.rootFont)
  const content = found.main.contentRight - found.main.contentLeft
  const centre = (found.main.left + found.main.right) / 2
  const containerCentre = (found.header.left + found.header.right) / 2

  expect(Math.abs(found.main.width - outer)).toBeLessThan(EPSILON)
  expect(found.main.paddingLeft).toBe(gutter)
  expect(found.main.paddingRight).toBe(gutter)
  expect(Math.abs(content - (outer - 2 * gutter))).toBeLessThan(EPSILON)
  expect(Math.abs(centre - containerCentre)).toBeLessThan(EPSILON)
  expect(found.main.left).toBeGreaterThanOrEqual(found.header.left - EPSILON)
  expect(found.main.right).toBeLessThanOrEqual(found.header.right + EPSILON)
  expect(found.main.contentLeft).toBeGreaterThanOrEqual(found.header.contentLeft - EPSILON)
  expect(found.main.contentRight).toBeLessThanOrEqual(found.header.contentRight + EPSILON)
}

async function visit(page: Page, path: string, heading: string): Promise<Geometry> {
  await page.goto(`${WEB_ORIGIN}${path}`)
  await page.getByRole('heading', { level: 1, name: heading }).waitFor()
  await page.waitForLoadState('networkidle')

  return geometry(page)
}

describe('BS-133: shared page container', () => {
  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      it(`guest header and sign-in form, ${String(width)} px, ${theme} theme`, async () => {
        const page = await openContext(width, theme, false)

        expectMeasuredPage(await visit(page, '/login', 'Вхід'), theme, NARROW_MEASURE)
      })

      it(`signed-in header, wide pages and add-book forms, ${String(width)} px, ${theme} theme`, async () => {
        const page = await openContext(width, theme, true)
        const add = new URLSearchParams({ q: token })
        const refine = new URLSearchParams(edition)

        // Wide: the library, «Доступні від друзів» with a friend's long title, add-book results.
        expectWidePage(await visit(page, '/library', 'Моя бібліотека'), theme)
        expectWidePage(await visit(page, `/catalog?q=${token}`, 'Доступні від друзів'), theme)
        await page
          .getByRole('link', { name: new RegExp(token) })
          .first()
          .waitFor()
        expectWidePage(await geometry(page), theme)
        await page.goto(`${WEB_ORIGIN}/catalog/new?${add.toString()}`)
        await page
          .getByRole('button', { name: new RegExp(token) })
          .first()
          .waitFor()
        await page.waitForLoadState('networkidle')
        expectWidePage(await geometry(page), theme)

        // Narrow: manual entry and «Уточнити дані» keep their 672 px outer width.
        expectMeasuredPage(
          await visit(page, '/catalog/new?mode=manual', 'Додати книжку вручну'),
          theme,
          MEDIUM_MEASURE,
        )
        expectMeasuredPage(
          await visit(page, `/catalog/new?${refine.toString()}`, 'Уточнити дані'),
          theme,
          MEDIUM_MEASURE,
        )
      })
    }
  }

  // The cap is CSS px: a reader's larger default font scales the gutters and the text, not the cap.
  for (const fontSize of [16, 20]) {
    it(`the 1440 px cap holds at a ${String(fontSize)} px root font`, async () => {
      for (const width of [1600, 1920, 2560]) {
        const guest = await openContext(width, 'light', false, fontSize)

        try {
          const login = await visit(guest, '/login', 'Вхід')

          expect(login.rootFont).toBe(fontSize)
          expectMeasuredPage(login, 'light', NARROW_MEASURE)
        } finally {
          // Each scenario owns its context: the font preference never reaches another test.
          await guest.context().close()
        }

        const member = await openContext(width, 'light', true, fontSize)

        try {
          const library = await visit(member, '/library', 'Моя бібліотека')

          expect(library.rootFont).toBe(fontSize)
          expectWidePage(library, 'light')
          expectMeasuredPage(
            await visit(member, '/catalog/new?mode=manual', 'Додати книжку вручну'),
            'light',
            MEDIUM_MEASURE,
          )
        } finally {
          await member.context().close()
        }
      }
    })
  }

  it('the loading and the session-error header states use the same container', async () => {
    for (const width of [320, 1920]) {
      // Loading: the session request is held, so the header stays on its skeleton while measured.
      const loading = await openContext(width, 'light', false)
      let release: () => void = () => undefined
      const held = new Promise<void>((resolve) => {
        release = resolve
      })

      await loading.route('**/auth/session', async (route) => {
        await held
        // The page may already be gone by then: nothing is left to answer.
        await route.continue().catch(() => undefined)
      })
      await loading.goto(`${WEB_ORIGIN}/login`)
      await loading.locator('[aria-label="Основні дії"][aria-busy="true"]').waitFor()
      expectMeasuredPage(await geometry(loading), 'light', NARROW_MEASURE)
      release()

      // Session error: the request fails, the header falls back to the guest links.
      const failed = await openContext(width, 'light', false)

      await failed.route('**/auth/session', (route) => route.abort())
      await failed.goto(`${WEB_ORIGIN}/catalog/new`)
      await failed.getByRole('link', { name: 'Увійти' }).first().waitFor()
      await failed.waitForLoadState('networkidle')
      expectWidePage(await geometry(failed), 'light')
    }
  })

  it('a wide table scrolls inside its own frame, not the page, at 320 px', async () => {
    const page = await openContext(320, 'light', true)
    const found = await visit(page, '/notifications/settings', 'Налаштування сповіщень')
    const frame = await page
      .locator('.matrix-scroll')
      .evaluate((element) => ({ overflowX: getComputedStyle(element).overflowX }))

    expectWidePage(found, 'light')
    expect(frame.overflowX).toBe('auto')
  })

  it('keyboard focus on the edge controls stays fully on screen', async () => {
    for (const width of [320, 1920]) {
      const page = await openContext(width, 'light', true)

      await visit(page, '/library', 'Моя бібліотека')
      await page.locator('body').focus()
      await page.keyboard.press('Tab')

      const focus = await page.evaluate(() => {
        const element = document.activeElement

        if (element === null) throw new Error('Nothing focused')

        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)

        return {
          label: element.getAttribute('aria-label') ?? element.textContent,
          ring: style.outlineStyle !== 'none' || style.boxShadow !== 'none',
          left: rect.left - ring,
          right: rect.right + ring,
          viewport: document.documentElement.clientWidth,
        }
      })

      // At 320 px the first stop is the menu button, wider it is the logo: either way the left edge.
      expect(focus.ring).toBe(true)
      expect(focus.left).toBeGreaterThanOrEqual(0)
      expect(focus.right).toBeLessThanOrEqual(focus.viewport)
    }
  })
})
