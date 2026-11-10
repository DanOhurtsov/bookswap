import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { befriend, requestLoan, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * Рішення PO від 10.11.2026: АВТОМАТИЧНИЙ браузерний e2e двох екранів запиту з макета канви —
 * відповіді власника на `/loans?loanId=` і запиту позичальника з бібліотеки друга `/u/<handle>`.
 * Реальні web (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній
 * Chromium. Відповіді продуктового API не підмінено, нічого не затримано.
 *
 * Імена й назви навмисне довгі: вони мають переноситися, а не виштовхувати сторінку вбік. «Масштаб
 * 200%» — це 1440 px екрана при подвоєному масштабі: 720 CSS px шириною, `deviceScaleFactor: 2`.
 *
 * `BROWSER_SCREENSHOT_DIR` (необовʼязково) — куди покласти знімки для ручного перегляду.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser -- loan-request-flows`. Без Chromium тест ПАДАЄ.
 */

const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]

/** Phone, tablet, desktop — and the desktop at 200%. */
const SIZES = [
  { name: '390', width: 390, height: 844, scale: 1 },
  { name: '834', width: 834, height: 1112, scale: 1 },
  { name: '1440', width: 1440, height: 900, scale: 1 },
  { name: '1440-zoom200', width: 720, height: 450, scale: 2 },
] as const
type Size = (typeof SIZES)[number]

const LONG_NAME = 'Олександра-Вікторія Костянтинівна Шевченко-Лукʼяненко-Квітка-Основʼяненко'
const LONG_TITLE =
  'Неймовірно довга назва книжки про те, як друзі позичають одне одному книжки, повертають їх вчасно і ще встигають поговорити про прочитане'
const DAY_MS = 24 * 60 * 60 * 1000

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let sequence = 0
const contexts: BrowserContext[] = []

interface Reader extends Account {
  email: string
  handle: string
}

beforeAll(async () => {
  app = await createTestApp()
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
}, 240_000)

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined)
})

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

async function registerReader(prefix: string, name: string): Promise<Reader> {
  sequence += 1

  const email = uniqueEmail(prefix)
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: name })
    .expect(201)
  const { user } = response.body as { user: { id: string; handle: string } }

  return {
    id: user.id,
    handle: user.handle,
    cookie: sessionCookie(response.headers),
    displayName: name,
    email,
  }
}

/** A work, its edition and a copy of it on `owner`'s shelf; returns the copy. */
async function addBook(owner: Reader, title: string): Promise<string> {
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
    .send({ publisher: 'Запит', year: 2024 })
    .expect(201)
  const editionId = (edition.body as { edition: { id: string } }).edition.id
  const copy = await request(server)
    .post(url('/me/library'))
    .set('Cookie', owner.cookie)
    .send({ editionId, visibility: 'FRIENDS' })
    .expect(201)

  return (copy.body as { copy: { id: string } }).copy.id
}

async function newPage(size: Size, theme: Theme = 'light'): Promise<Page> {
  const touch = size.width < 1024 && size.scale === 1
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: size.scale,
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
  await page.goto(`${WEB_ORIGIN}/login`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Пароль').fill(VALID_PASSWORD)
  await page.getByRole('button', { name: 'Увійти' }).click()
  await page.waitForURL(`${WEB_ORIGIN}/`)
}

/** The whole page; `fullPage: false` for the phone's sheet, which stays fixed and scrolls itself. */
async function screenshot(page: Page, name: string, fullPage = true): Promise<void> {
  const directory = process.env.BROWSER_SCREENSHOT_DIR

  if (directory === undefined) return
  // A full page is taken from the top: scrolled, the sticky header would be drawn mid-page.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({
    path: join(directory, `${name}.png`),
    fullPage,
    animations: 'disabled',
  })
}

/** How far the page runs past the viewport sideways; 0 when nothing does. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
}

/** «2026-11-15» → «15.11.26», as the page writes it. */
function shortDate(day: string): string {
  const [year, month, date] = day.split('-')

  return `${date!}.${month!}.${year!.slice(2)}`
}

/** The local calendar day `days` from today, as the page computes it. */
function localDayFromNow(days: number): string {
  const at = new Date(Date.now() + days * DAY_MS)

  return [
    String(at.getFullYear()),
    String(at.getMonth() + 1).padStart(2, '0'),
    String(at.getDate()).padStart(2, '0'),
  ].join('-')
}

/** PageDown in the calendar: the same date a month on, the month's last day when it has none. */
function monthOn(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const next = new Date(Date.UTC(year, month, Math.min(date, last)))

  return next.toISOString().slice(0, 10)
}

/** A long-named friend asks `owner` for the long-titled book, with a note and no date. */
async function askedByLongName(prefix: string) {
  const owner = await registerReader(`${prefix}-o`, `Власниця ${prefix}`)
  const borrower = await registerReader(`${prefix}-b`, LONG_NAME)

  await befriend(app, owner, borrower)

  const copyId = await addBook(owner, `${LONG_TITLE} ${prefix}`)
  const created = await requestLoan(app, borrower, copyId, {
    message: 'Давно хотіла перечитати, поверну вчасно. Можу забрати будь-якого вечора біля метро.',
  }).expect(201)

  return { owner, borrower, loanId: (created.body as { loan: { id: string } }).loan.id }
}

describe('запит до власника: /loans?loanId= (рішення PO від 10.11.2026)', () => {
  it('довге імʼя й назва переносяться на 390/834/1440 і при 200% — без горизонтального скролу', async () => {
    const { owner, loanId } = await askedByLongName('ow-shots')

    for (const theme of THEMES) {
      for (const size of SIZES) {
        const page = await newPage(size, theme)

        await login(page, owner.email)
        await page.goto(`${WEB_ORIGIN}/loans?loanId=${loanId}`)
        await page.getByRole('heading', { name: 'Запит на книжку' }).waitFor()
        await page.getByRole('region', { name: 'Хто просить' }).getByText(LONG_NAME).waitFor()
        await page.waitForLoadState('networkidle')

        expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
        expect(
          await page.getByRole('radio', { name: /^Без дати/ }).getAttribute('aria-checked'),
        ).toBe('true')
        expect(await page.getByRole('button', { name: 'Погодити без терміну' }).isEnabled()).toBe(
          true,
        )
        await screenshot(page, `owner-request-${size.name}-${theme}`)
      }
    }
  })

  it('клавіатура: стрілки по табах, PageDown на два місяці вперед, Enter — і PATCH несе саме цю дату', async () => {
    const { owner, loanId } = await askedByLongName('ow-keys')
    const page = await newPage(SIZES[2])

    await login(page, owner.email)
    await page.goto(`${WEB_ORIGIN}/loans?loanId=${loanId}`)

    const none = page.getByRole('radio', { name: /^Без дати/ })

    await none.waitFor()
    await page.waitForLoadState('networkidle')

    // Tab enters the group at its checked option; the arrows move the choice.
    await none.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')

    const fortnight = page.getByRole('radio', { name: /^2 тижні/ })

    expect(await fortnight.getAttribute('aria-checked')).toBe('true')
    expect(await fortnight.evaluate((element) => element === document.activeElement)).toBe(true)

    const presetDay = localDayFromNow(14)

    expect(await page.locator('.loan-term__due').textContent()).toBe(shortDate(presetDay))

    // The calendar: the chosen day holds the Tab stop; PageDown turns the month with it.
    await page.locator(`[data-day="${presetDay}"]`).focus()
    await page.keyboard.press('PageDown')
    await page.keyboard.press('PageDown')

    const chosen = monthOn(monthOn(presetDay))
    const focused = page.locator(`[data-day="${chosen}"]`)

    await focused.waitFor()
    expect(await focused.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press('Enter')

    expect(await page.locator('.loan-term__due').textContent()).toBe(shortDate(chosen))
    expect(await page.getByRole('radio', { name: /^Своя дата/ }).getAttribute('aria-checked')).toBe(
      'true',
    )
    await screenshot(page, 'owner-request-keyboard-1440-light')

    const patched = page.waitForRequest(
      (sent: Request) =>
        sent.method() === 'PATCH' && new URL(sent.url()).pathname === `/api/v1/loans/${loanId}`,
    )

    await page.getByRole('button', { name: `Погодити до ${shortDate(chosen)}` }).click()
    expect((await patched).postDataJSON()).toEqual({ action: 'approve', dueAt: chosen })

    const title = page.getByRole('heading', { name: 'Запит погоджено' })

    await title.waitFor()
    expect(await page.getByRole('status').filter({ has: title }).textContent()).toContain(
      `Повернути до ${shortDate(chosen)}.`,
    )
    await screenshot(page, 'owner-request-approved-1440-light')
  })

  it('погоджено на телефоні: результат замість форми, без горизонтального скролу', async () => {
    const { owner, loanId } = await askedByLongName('ow-phone')
    const page = await newPage(SIZES[0])

    await login(page, owner.email)
    await page.goto(`${WEB_ORIGIN}/loans?loanId=${loanId}`)
    await page.getByRole('button', { name: 'Погодити без терміну' }).click()
    await page.getByRole('heading', { name: 'Запит погоджено' }).waitFor()

    expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
    await screenshot(page, 'owner-request-approved-390-light')
  })
})

describe('запит позичальника: бібліотека друга /u/<handle> (рішення PO від 10.11.2026)', () => {
  /** An owner with a long name and two long-titled books; a friend to ask them. */
  async function shelfOf(prefix: string) {
    const owner = await registerReader(`${prefix}-o`, LONG_NAME)
    const borrower = await registerReader(`${prefix}-b`, `Позичальниця ${prefix}`)

    await befriend(app, owner, borrower)

    const titles = [`${LONG_TITLE} ${prefix} А`, `${LONG_TITLE} ${prefix} Б`]

    for (const title of titles) await addBook(owner, title)

    return { owner, borrower, titles }
  }

  async function openShelf(page: Page, borrower: Reader, owner: Reader): Promise<void> {
    await login(page, borrower.email)
    await page.goto(`${WEB_ORIGIN}/u/${owner.handle}`)
    await page.getByRole('heading', { name: `Бібліотека: ${owner.displayName}` }).waitFor()
    await page.waitForLoadState('networkidle')
  }

  function book(page: Page, title: string) {
    return page.locator('li.book').filter({ hasText: title })
  }

  it('телефон — bottom sheet, від 834 — під примірником; «Без дати» обрано; без горизонтального скролу', async () => {
    const { owner, borrower, titles } = await shelfOf('bw-shots')

    for (const theme of THEMES) {
      for (const size of SIZES) {
        const page = await newPage(size, theme)

        await openShelf(page, borrower, owner)
        await book(page, titles[0]!).getByRole('button', { name: 'Попросити' }).click()

        const sheet = page.getByRole('dialog', { name: 'Попросити книжку' })
        const isPhone = size.width < 768

        if (isPhone) {
          await sheet.waitFor()
          expect(await sheet.getByText(titles[0]!).count()).toBe(1)
        } else {
          await page.getByRole('region', { name: 'Новий запит' }).waitFor()
          expect(await sheet.count()).toBe(0)
        }

        expect(
          await page.getByRole('radio', { name: /^Без дати/ }).getAttribute('aria-checked'),
        ).toBe('true')
        expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)

        if (isPhone) {
          await screenshot(page, `borrow-request-${size.name}-${theme}-top`, false)
          // The sheet's own end: the note and the buttons, reachable by scrolling the sheet.
          await sheet.getByRole('button', { name: 'Надіслати запит' }).scrollIntoViewIfNeeded()
          expect(await sheet.getByRole('button', { name: 'Надіслати запит' }).isVisible()).toBe(
            true,
          )
          await screenshot(page, `borrow-request-${size.name}-${theme}-bottom`, false)
        } else {
          await screenshot(page, `borrow-request-${size.name}-${theme}`)
        }
      }
    }
  })

  for (const size of [SIZES[0], SIZES[2]]) {
    it(`${size.name}: подвійне натискання — один POST; «Запит надіслано» відкриває саме цей запит`, async () => {
      const { owner, borrower, titles } = await shelfOf(`bw-send-${size.name}`)
      const page = await newPage(size)
      const posts: Request[] = []

      page.on('request', (sent: Request) => {
        if (sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/loans')
          posts.push(sent)
      })

      await openShelf(page, borrower, owner)
      await book(page, titles[1]!).getByRole('button', { name: 'Попросити' }).click()
      await page.getByRole('radio', { name: /^3 тижні/ }).click()
      await page.getByRole('textbox', { name: /Повідомлення власнику/ }).fill('Поверну вчасно')

      const created = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/v1/loans',
      )

      await page.getByRole('button', { name: 'Надіслати запит' }).dblclick()

      const { loan } = (await (await created).json()) as { loan: { id: string } }

      await page.getByRole('heading', { name: 'Запит надіслано' }).waitFor()
      expect(posts).toHaveLength(1)
      expect(posts[0]!.postDataJSON()).toEqual({
        copyId: expect.any(String) as string,
        message: 'Поверну вчасно',
        proposedDueAt: localDayFromNow(21),
      })

      const href = await page.getByRole('link', { name: 'Відкрити запит' }).getAttribute('href')
      const address = new URL(href!, WEB_ORIGIN)

      expect(address.pathname).toBe('/loans')
      expect([...address.searchParams]).toEqual([
        ['loanId', loan.id],
        ['role', 'borrower'],
      ])
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
      await screenshot(page, `borrow-request-sent-${size.name}-light`, size.width >= 768)

      await page.getByRole('link', { name: 'Відкрити запит' }).click()
      await page.waitForURL((current) => current.pathname === '/loans')
      expect([...new URL(page.url()).searchParams]).toEqual([
        ['loanId', loan.id],
        ['role', 'borrower'],
      ])
    })
  }
})
