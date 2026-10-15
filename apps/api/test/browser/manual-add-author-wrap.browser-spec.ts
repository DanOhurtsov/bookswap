import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { CATALOG_LIMITS } from '@bookswap/shared'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
  type Request,
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { VALID_PASSWORD, createTestApp, uniqueEmail } from '../auth.helpers'
import { url } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-76 review: an author's name with no spaces must wrap inside its column in the manual add form's
 * text view — whole, without an ellipsis, never under the pencil and never widening the page.
 *
 * Geometry is the subject, so this runs in a real Chromium against the real web (`next dev`) and API
 * (`createTestApp` in this process) over the test database: no API response is stubbed. jsdom has no
 * layout and cannot tell a wrapped line from an overflowing one.
 *
 * Run: `pnpm --filter @bookswap/api test:browser`. Without Chromium the test FAILS (is not skipped).
 */

const WIDTHS = [320, 390, 768, 1024, 1280] as const
const THEMES = ['light', 'dark'] as const

/** The case from the review: «Нечуй» ten times, no spaces. */
const NECHUI = 'Нечуй'.repeat(10)
/** The longest names the form accepts, one per script. */
const LONGEST_CYRILLIC = 'Левицький'.repeat(30).slice(0, CATALOG_LIMITS.authorNameMax)
const LONGEST_LATIN = 'NechuiLevytskyi'.repeat(20).slice(0, CATALOG_LIMITS.authorNameMax)

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let storageState: BrowserContextOptions['storageState']
const contexts: BrowserContext[] = []

beforeAll(async () => {
  app = await createTestApp()
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
  storageState = await signedInState()
}, 240_000)

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

/** One sign-in through the real login page; every viewport then reuses its session. */
async function signedInState(): Promise<BrowserContextOptions['storageState']> {
  const email = uniqueEmail('br-manual-add')

  await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: 'Ручне додавання' })
    .expect(201)

  const context = await browser.newContext()
  const page = await context.newPage()

  await page.goto(`${WEB_ORIGIN}/login`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL((address) => !address.pathname.startsWith('/login'))

  const state = await context.storageState()

  await context.close()

  return state
}

interface Opened {
  page: Page
  /** Every request but a GET: saving or cancelling a field must add nothing to them. */
  writes: string[]
}

async function openManualForm(
  width: number,
  theme: (typeof THEMES)[number],
  authors: readonly string[] = [],
): Promise<Opened> {
  // Below 1024 px — a touch device: no hover, so the pencil is always shown.
  const touch = width < 1024
  const context = await browser.newContext({
    storageState,
    viewport: { width, height: 900 },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  })

  contexts.push(context)
  await context.addInitScript((value) => {
    window.localStorage.setItem('bookswap-theme', value)
  }, theme)

  const page = await context.newPage()
  const writes: string[] = []

  page.on('request', (sent: Request) => {
    if (sent.method() !== 'GET') writes.push(`${sent.method()} ${sent.url()}`)
  })

  const query = new URLSearchParams([
    ['mode', 'manual'],
    ...authors.map((name) => ['author', name]),
  ])

  await page.goto(`${WEB_ORIGIN}/catalog/new?${query.toString()}`)
  await page.getByRole('group', { name: 'Автори' }).waitFor()
  await page.waitForLoadState('networkidle')
  // Writes made while the page loads are not this test's subject.
  writes.length = 0

  return { page, writes }
}

interface AuthorsGeometry {
  names: string[]
  /** Per name: how many lines it takes, and whether any glyph sits outside its box. */
  lines: number[]
  clipped: boolean[]
  ellipsis: boolean[]
  /** The right edge of the text, the left edge of the pencil — the text must end before it. */
  textRight: number
  pencilLeft: number
  pageOverflow: number
}

function authorsGeometry(page: Page): Promise<AuthorsGeometry> {
  return page.getByRole('group', { name: 'Автори' }).evaluate((group): AuthorsGeometry => {
    const items = [...group.querySelectorAll('li')]
    const pencil = group.querySelector('[aria-label="Редагувати: Автори"]')

    if (pencil === null) throw new Error('No pencil in the authors row')

    const textRects = items.map((item) => {
      const range = document.createRange()

      range.selectNodeContents(item)

      return range
    })

    return {
      names: items.map((item) => item.textContent ?? ''),
      lines: textRects.map(
        (range) => new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
      ),
      clipped: items.map((item) => item.scrollWidth > item.clientWidth),
      ellipsis: items.map((item) => getComputedStyle(item).textOverflow === 'ellipsis'),
      textRight: Math.max(...textRects.map((range) => range.getBoundingClientRect().right)),
      pencilLeft: pencil.getBoundingClientRect().left,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

function expectContained(geometry: AuthorsGeometry, names: readonly string[]): void {
  // In the draft's order, every name whole.
  expect(geometry.names).toEqual(names)
  expect(geometry.clipped).toEqual(names.map(() => false))
  expect(geometry.ellipsis).toEqual(names.map(() => false))
  expect(geometry.textRight).toBeLessThanOrEqual(geometry.pencilLeft)
  expect(geometry.pageOverflow).toBe(0)
}

describe('BS-76: a long author name wraps in the manual form', () => {
  const prefilled = [NECHUI, LONGEST_LATIN, 'Іван Франко', LONGEST_CYRILLIC]

  for (const theme of THEMES) {
    for (const width of WIDTHS) {
      it(`from the URL: several names, ${String(width)} px, ${theme} theme`, async () => {
        const { page, writes } = await openManualForm(width, theme, prefilled)
        const geometry = await authorsGeometry(page)

        expectContained(geometry, prefilled)
        // The longest name cannot fit one line at any of these widths: it really wraps.
        expect(geometry.lines[1]).toBeGreaterThan(1)
        expect(writes).toEqual([])
      })
    }
  }

  for (const width of WIDTHS) {
    it(`typed in the editor and confirmed locally: one name, then two, ${String(width)} px`, async () => {
      const { page, writes } = await openManualForm(width, 'light')

      await page.getByRole('button', { name: 'Додати автора' }).click()
      await page.getByRole('textbox', { name: 'Автор', exact: true }).fill(NECHUI)
      await page.getByRole('button', { name: 'Зберегти: Автори' }).click()
      expectContained(await authorsGeometry(page), [NECHUI])

      await page.getByRole('button', { name: 'Редагувати: Автори' }).click()
      await page.getByRole('button', { name: 'Додати автора' }).click()
      await page.getByRole('textbox', { name: 'Автор 2' }).fill(LONGEST_LATIN)
      await page.getByRole('button', { name: 'Зберегти: Автори' }).click()
      expectContained(await authorsGeometry(page), [NECHUI, LONGEST_LATIN])

      expect(writes).toEqual([])
    })
  }

  it('keyboard at 320 px: Enter confirms, «Скасувати» restores, focus returns to the pencil', async () => {
    const { page, writes } = await openManualForm(320, 'dark', [NECHUI])
    const pencil = page.getByRole('button', { name: 'Редагувати: Автори' })
    const first = page.getByRole('textbox', { name: 'Автор', exact: true })

    await pencil.focus()
    await page.keyboard.press('Enter')
    await expect(first.evaluate((element) => element === document.activeElement)).resolves.toBe(
      true,
    )
    await page.keyboard.press('Control+A')
    await page.keyboard.type(LONGEST_CYRILLIC)
    await page.keyboard.press('Enter')
    await expect(pencil.evaluate((element) => element === document.activeElement)).resolves.toBe(
      true,
    )
    expectContained(await authorsGeometry(page), [LONGEST_CYRILLIC])

    await page.keyboard.press('Enter')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Хтось інший')
    // Tab from the name past «Додати автора» and ✓ to ✕.
    for (let step = 0; step < 3; step += 1) await page.keyboard.press('Tab')
    await expect(
      page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
    ).resolves.toBe('Скасувати: Автори')
    await page.keyboard.press('Enter')
    await expect(pencil.evaluate((element) => element === document.activeElement)).resolves.toBe(
      true,
    )
    expectContained(await authorsGeometry(page), [LONGEST_CYRILLIC])

    expect(writes).toEqual([])
  })
})
