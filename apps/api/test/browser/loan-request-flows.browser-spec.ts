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
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { befriend, requestLoan, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * Рішення PO від 10.11.2026: АВТОМАТИЧНИЙ браузерний e2e двох екранів запиту з макета канви —
 * відповіді власника на `/loans?loanId=` і запиту позичальника з бібліотеки друга `/u/<handle>`; issue
 * #87 — той самий запит із «Хто має цю книжку?» на сторінці твору `/works/<id>`. Реальні web
 * (`next dev`) і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium.
 * Відповіді продуктового API не підмінено, нічого не затримано.
 *
 * Підстановки, і лише такі (сторінка твору):
 * - сценарій збою: перший POST браузер обриває на рівні мережі (`route.abort`), повтор іде до
 *   справжнього API;
 * - «інша вкладка» в сценаріях 409 — виклик API від імені позичальника чи власника поза браузером;
 *   примірник, що став недоступним, — статус, виставлений у БД.
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

/** A work, its edition and a copy of it on `owner`'s shelf. */
async function addBook(owner: Reader, title: string): Promise<{ workId: string; copyId: string }> {
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

  return { workId, copyId: (copy.body as { copy: { id: string } }).copy.id }
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

  const { copyId } = await addBook(owner, `${LONG_TITLE} ${prefix}`)
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

describe('запит з «Хто має цю книжку?»: сторінка твору /works/<id> (issue #87)', () => {
  /** A long-named friend's long-titled book, asked for on the page of its work. */
  async function holdersOf(prefix: string) {
    const owner = await registerReader(`${prefix}-o`, LONG_NAME)
    const borrower = await registerReader(`${prefix}-b`, `Позичальниця ${prefix}`)

    await befriend(app, owner, borrower)

    const title = `${LONG_TITLE} ${prefix}`
    const { workId, copyId } = await addBook(owner, title)

    return { owner, borrower, title, workId, copyId }
  }

  function holders(page: Page) {
    return page
      .locator('section.friends-section')
      .filter({ has: page.getByRole('heading', { name: 'Хто має цю книжку?' }) })
  }

  async function openWork(page: Page, borrower: Reader, workId: string): Promise<void> {
    await login(page, borrower.email)
    await page.goto(`${WEB_ORIGIN}/works/${workId}`)
    await holders(page).getByRole('button', { name: 'Попросити' }).waitFor()
    await page.waitForLoadState('networkidle')
  }

  const isLoanPost = (sent: Request) =>
    sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/loans'

  /** The form, under the copy or in the phone's sheet: the same region either way. */
  const form = (page: Page) => page.getByRole('region', { name: 'Новий запит' })

  it('834 — під примірником, 390 — bottom sheet; перехід через 48rem в обидва боки зберігає дату, повідомлення й помилку; повтор надсилає те саме', async () => {
    const { borrower, title, workId, copyId } = await holdersOf('hp-turn')
    const page = await newPage(SIZES[1])
    const posts: unknown[] = []
    let failing = true

    page.on('request', (sent: Request) => {
      if (isLoanPost(sent)) posts.push(sent.postDataJSON())
    })
    await page.route(
      (address) => address.pathname === '/api/v1/loans',
      async (route) => {
        if (failing && route.request().method() === 'POST') await route.abort('failed')
        else await route.continue()
      },
    )

    await openWork(page, borrower, workId)
    await holders(page).getByRole('button', { name: 'Попросити' }).click()

    const sheet = page.getByRole('dialog', { name: 'Попросити книжку' })
    const note = form(page).getByRole('textbox', { name: /Повідомлення власнику/ })
    const due = localDayFromNow(14)

    await form(page).waitFor()
    expect(await sheet.count()).toBe(0)
    expect(await holders(page).getByRole('region', { name: 'Новий запит' }).count()).toBe(1)
    expect(
      await form(page)
        .getByRole('radio', { name: /^Без дати/ })
        .getAttribute('aria-checked'),
    ).toBe('true')
    // The panel holds no form element of its own: the request's buttons submit nothing around them.
    expect(await holders(page).locator('form').count()).toBe(0)

    await form(page)
      .getByRole('radio', { name: /^2 тижні/ })
      .click()
    await note.fill('Поверну за два тижні')
    await form(page).getByRole('button', { name: 'Надіслати запит' }).click()
    await form(page).getByRole('alert').waitFor()

    const kept = async (width: number) => {
      expect({
        width,
        note: await note.inputValue(),
        due: await form(page).locator('.loan-term__due').textContent(),
        alert: await form(page).getByRole('alert').innerText(),
        overflow: await sidewaysOverflow(page),
      }).toEqual({
        width,
        note: 'Поверну за два тижні',
        due: shortDate(due),
        alert:
          'Не вдалося надіслати запит. Перевірте зʼєднання і спробуйте ще раз. Дата й повідомлення збережені.',
        overflow: 0,
      })
    }

    await kept(834)
    await screenshot(page, 'holders-request-failed-834-light')

    await page.setViewportSize({ width: 390, height: 844 })
    await sheet.waitFor()
    expect(await sheet.getByText(title).count()).toBe(1)
    await kept(390)
    await screenshot(page, 'holders-request-failed-390-light', false)

    await page.setViewportSize({ width: 834, height: 1112 })
    await sheet.waitFor({ state: 'detached' })
    await kept(834)

    failing = false
    await form(page).getByRole('button', { name: 'Надіслати запит' }).click()
    await page.getByRole('heading', { name: 'Запит надіслано' }).waitFor()

    const body = { copyId, message: 'Поверну за два тижні', proposedDueAt: due }

    expect(posts).toEqual([body, body])
  })

  for (const size of [SIZES[0], SIZES[2]]) {
    it(`${size.name}: подвійне натискання — один POST; «Запит надіслано» відкриває саме цей запит і переживає перечитування; «Закрити» лишає фокус біля примірника`, async () => {
      const { borrower, workId, copyId } = await holdersOf(`hp-send-${size.name}`)
      const page = await newPage(size)
      const posts: Request[] = []
      const reads: string[] = []

      page.on('request', (sent: Request) => {
        if (isLoanPost(sent)) posts.push(sent)
        if (new URL(sent.url()).pathname === `/api/v1/works/${workId}/holders`)
          reads.push(sent.url())
      })

      await openWork(page, borrower, workId)

      const readsBefore = reads.length

      await holders(page).getByRole('button', { name: 'Попросити' }).click()
      await form(page)
        .getByRole('radio', { name: /^3 тижні/ })
        .click()
      await form(page)
        .getByRole('textbox', { name: /Повідомлення власнику/ })
        .fill('Поверну вчасно')

      const created = page.waitForResponse(
        (response) => isLoanPost(response.request()) && response.status() === 201,
      )

      await form(page).getByRole('button', { name: 'Надіслати запит' }).dblclick()

      const { loan } = (await (await created).json()) as { loan: { id: string } }
      const outcome = page.locator('.loan-outcome')
      const title = outcome.getByRole('heading', { name: 'Запит надіслано' })

      await title.waitFor()
      await page.waitForLoadState('networkidle')

      expect(posts).toHaveLength(1)
      expect(posts[0]!.postDataJSON()).toEqual({
        copyId,
        message: 'Поверну вчасно',
        proposedDueAt: localDayFromNow(21),
      })
      // The list is read again once, and the outcome stays over it.
      expect(reads.length - readsBefore).toBe(1)
      expect(await title.isVisible()).toBe(true)
      // Under the copy the outcome's title takes the focus. In the phone's sheet the focus stays inside
      // the dialog — on its title, or on the dialog itself when Base UI's focus manager takes it back
      // once the pressed button is gone (`BorrowRequestForm` as on a friend's shelf; PO decision on
      // issue #87). The focus is not lost either way, and the outcome, a status, is announced.
      expect(
        await page.evaluate(() => {
          const active = document.activeElement

          if (active?.closest('[role="dialog"]') != null) return 'sheet'

          return active?.matches('.loan-outcome__title') === true ? 'title' : 'elsewhere'
        }),
      ).toBe(size.width >= 768 ? 'title' : 'sheet')

      const href = await outcome.getByRole('link', { name: 'Відкрити запит' }).getAttribute('href')

      expect([...new URL(href!, WEB_ORIGIN).searchParams]).toEqual([
        ['loanId', loan.id],
        ['role', 'borrower'],
      ])
      expect(await sidewaysOverflow(page)).toBeLessThanOrEqual(0)
      await screenshot(page, `holders-request-sent-${size.name}-light`, size.width >= 768)

      // Announced: the outcome is a status, and on the phone it is inside the dialog.
      expect(await page.getByRole('status').filter({ hasText: 'Запит надіслано' }).count()).toBe(1)
      expect(await page.getByRole('dialog').locator('.loan-outcome').count()).toBe(
        size.width >= 768 ? 0 : 1,
      )

      // By keyboard alone: Tab reaches «Закрити» — on the phone never leaving the sheet — and Enter
      // closes the outcome.
      const stops: string[] = []

      for (let step = 0; step < 8; step += 1) {
        await page.keyboard.press('Tab')

        const stop = await page.evaluate(() => {
          const active = document.activeElement

          return {
            name: active?.textContent?.trim() ?? '',
            inOutcome: active?.closest('.loan-outcome') !== null,
            inSheet: active?.closest('[role="dialog"]') !== null,
          }
        })

        stops.push(size.width >= 768 || stop.inSheet ? 'kept' : `left the sheet: ${stop.name}`)
        if (stop.inOutcome && stop.name === 'Закрити') break
      }

      expect(stops.at(-1)).toBe('kept')
      expect(stops.filter((stop) => stop !== 'kept')).toEqual([])
      expect(
        await outcome
          .getByRole('button', { name: 'Закрити' })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true)
      await page.keyboard.press('Enter')
      await outcome.waitFor({ state: 'detached' })

      // The re-read copy can no longer be asked for: the focus stays on its own line.
      const copyLine = holders(page).locator('li.copy > .book__meta').first()

      expect(await holders(page).getByRole('button', { name: 'Попросити' }).count()).toBe(0)
      expect(await holders(page).getByText('Зараз попросити не можна.').count()).toBe(1)
      await page.waitForFunction(() => document.activeElement?.matches('li.copy > .book__meta'))
      expect(await copyLine.evaluate((element) => element === document.activeElement)).toBe(true)
    })
  }

  it('409: дублікат, недоступний примірник, пауза власника — кожен своїм результатом, без посилання й без повтору', async () => {
    const owner = await registerReader('hp-409-o', LONG_NAME)
    const borrower = await registerReader('hp-409-b', 'Позичальниця hp-409')
    const prisma = app.get(PrismaService)

    await befriend(app, owner, borrower)

    const cases = [
      {
        code: 'LOAN_DUPLICATE_REQUEST',
        title: 'Запит уже надіслано',
        // Asked in another tab while this form was open.
        meanwhile: async (copyId: string) => {
          await requestLoan(app, borrower, copyId).expect(201)
        },
      },
      {
        code: 'LOAN_COPY_UNAVAILABLE',
        title: 'Книжку зараз не можна попросити',
        meanwhile: async (copyId: string) => {
          await prisma.copy.update({ where: { id: copyId }, data: { status: 'UNAVAILABLE' } })
        },
      },
      {
        code: 'LOAN_REQUESTS_PAUSED',
        title: 'Власник зараз не приймає запитів',
        meanwhile: async () => {
          await request(app.getHttpServer())
            .patch(url('/me'))
            .set('Cookie', owner.cookie)
            .send({ loanRequestsPaused: true })
            .expect(200)
        },
      },
    ]

    for (const each of cases) {
      const { workId, copyId } = await addBook(owner, `${LONG_TITLE} hp-409 ${each.code}`)
      const page = await newPage(SIZES[2])
      const posts: Request[] = []

      page.on('request', (sent: Request) => {
        if (isLoanPost(sent)) posts.push(sent)
      })

      await openWork(page, borrower, workId)
      await holders(page).getByRole('button', { name: 'Попросити' }).click()
      await each.meanwhile(copyId)

      const refused = page.waitForResponse((response) => isLoanPost(response.request()))

      await form(page).getByRole('button', { name: 'Надіслати запит' }).click()

      const answer = await refused
      const outcome = page.locator('.loan-outcome')

      await outcome.getByRole('heading', { name: each.title }).waitFor()
      expect({
        status: answer.status(),
        code: ((await answer.json()) as { code: string }).code,
        links: await outcome.getByRole('link').count(),
        alerts: await holders(page).getByRole('alert').count(),
        posts: posts.length,
      }).toEqual({ status: 409, code: each.code, links: 0, alerts: 0, posts: 1 })
      await screenshot(page, `holders-request-409-${each.code}-1440-light`)
    }
  })
})

describe('запит з результатів пошуку /catalog (issue #87)', () => {
  const isLoanPost = (sent: Request) =>
    sent.method() === 'POST' && new URL(sent.url()).pathname === '/api/v1/loans'
  const isDiscovery = (sent: Request) => new URL(sent.url()).pathname === '/api/v1/catalog/discover'

  /** The result card of `title`, found by its own words in the circle. */
  function resultCard(page: Page, title: string) {
    return page.locator("li[data-slot='result-card']").filter({ hasText: title })
  }

  /**
   * After a request the list is read again so `canRequest` can flip: the outcome — success, a duplicate,
   * a pause — stays on screen once that read has answered, and so does the list it sits in.
   */
  it('успіх, дублікат і пауза: список перечитано одразу, а результат лишається на місці', async () => {
    const owner = await registerReader('cat-o', LONG_NAME)
    const borrower = await registerReader('cat-b', 'Позичальниця cat')

    await befriend(app, owner, borrower)

    const cases = [
      // Nothing in between: the request is created.
      { code: null, title: 'Запит надіслано', links: 1, meanwhile: () => Promise.resolve() },
      {
        code: 'LOAN_DUPLICATE_REQUEST',
        title: 'Запит уже надіслано',
        links: 0,
        meanwhile: async (copyId: string) => {
          await requestLoan(app, borrower, copyId).expect(201)
        },
      },
      {
        code: 'LOAN_REQUESTS_PAUSED',
        title: 'Власник зараз не приймає запитів',
        links: 0,
        meanwhile: async () => {
          await request(app.getHttpServer())
            .patch(url('/me'))
            .set('Cookie', owner.cookie)
            .send({ loanRequestsPaused: true })
            .expect(200)
        },
      },
    ]

    for (const each of cases) {
      sequence += 1

      const token = `каталогзапит${String(sequence)}`
      const title = `Книжка ${token}`
      const { copyId } = await addBook(owner, title)
      const page = await newPage(SIZES[2])

      await login(page, borrower.email)
      await page.goto(`${WEB_ORIGIN}/catalog?q=${encodeURIComponent(token)}`)

      const card = resultCard(page, title)

      await card.getByRole('button', { name: 'Попросити' }).click()
      await each.meanwhile(copyId)

      const answered = page.waitForResponse((response) => isLoanPost(response.request()))
      const reread = page.waitForResponse(
        (response) => isDiscovery(response.request()) && response.ok(),
      )

      await card.getByRole('button', { name: 'Надіслати запит' }).click()

      const answer = await answered

      await reread
      await page.waitForLoadState('networkidle')

      const outcome = card.locator('.loan-outcome')

      expect({
        status: answer.status(),
        code: answer.status() === 409 ? ((await answer.json()) as { code: string }).code : null,
        cards: await card.count(),
        shown: await outcome.getByRole('heading', { name: each.title }).isVisible(),
        links: await outcome.getByRole('link').count(),
        searching: await page.getByText('Шукаю…').count(),
      }).toEqual({
        status: each.code === null ? 201 : 409,
        code: each.code,
        cards: 1,
        shown: true,
        links: each.links,
        searching: 0,
      })
      await screenshot(page, `catalog-request-${each.code ?? 'sent'}-1440-light`)

      if (each.code === 'LOAN_REQUESTS_PAUSED') {
        await request(app.getHttpServer())
          .patch(url('/me'))
          .set('Cookie', owner.cookie)
          .send({ loanRequestsPaused: false })
          .expect(200)
      }
    }
  })

  /**
   * Discovery lists only copies at home (`availability=AVAILABLE` by default): read at once, the list
   * would take the refused copy's card — and the explanation in it — away. `/catalog` reads it only once
   * the explanation is closed, however it is closed (PO decision on issue #87, option (b)).
   */
  const CLOSINGS = [
    { size: SIZES[2], by: '«Закрити»' },
    { size: SIZES[0], by: '«Закрити»' },
    { size: SIZES[0], by: 'Escape' },
    { size: SIZES[0], by: '✕ шторки' },
  ] as const

  for (const closing of CLOSINGS) {
    it(`${closing.size.name}, ${closing.by}: LOAN_COPY_UNAVAILABLE — пояснення лишається, повтору немає; після закриття каталог перечитано, і картка зникла`, async () => {
      const prefix = `cat-u-${closing.size.name}-${String(CLOSINGS.indexOf(closing))}`
      const owner = await registerReader(`${prefix}-o`, LONG_NAME)
      const borrower = await registerReader(`${prefix}-b`, `Позичальниця ${prefix}`)

      await befriend(app, owner, borrower)
      sequence += 1

      const token = `недоступна${String(sequence)}`
      const title = `Книжка ${token}`
      const { copyId } = await addBook(owner, title)
      const page = await newPage(closing.size)
      const posts: Request[] = []
      const reads: Request[] = []

      page.on('request', (sent: Request) => {
        if (isLoanPost(sent)) posts.push(sent)
        if (isDiscovery(sent)) reads.push(sent)
      })

      await login(page, borrower.email)
      await page.goto(`${WEB_ORIGIN}/catalog?q=${encodeURIComponent(token)}`)

      const card = resultCard(page, title)

      await card.getByRole('button', { name: 'Попросити' }).click()
      await app
        .get(PrismaService)
        .copy.update({ where: { id: copyId }, data: { status: 'UNAVAILABLE' } })

      const refused = page.waitForResponse((response) => isLoanPost(response.request()))

      // Under the copy, or in the phone's sheet: the same region either way.
      await page
        .getByRole('region', { name: 'Новий запит' })
        .getByRole('button', { name: 'Надіслати запит' })
        .click()

      const answer = await refused
      const outcome = page.locator('.loan-outcome')
      const explanation = outcome.getByRole('heading', { name: 'Книжку зараз не можна попросити' })

      await explanation.waitFor()
      await page.waitForLoadState('networkidle')

      const readsBefore = reads.length

      expect({
        status: answer.status(),
        code: ((await answer.json()) as { code: string }).code,
        shown: await explanation.isVisible(),
        announced: await page
          .getByRole('status')
          .filter({ hasText: 'Книжку зараз не можна попросити' })
          .count(),
        inSheet: await page.getByRole('dialog').locator('.loan-outcome').count(),
        cards: await card.count(),
        // Nothing to send from: the explanation replaced the form, and «Попросити» did not come back.
        send: await page.getByRole('button', { name: 'Надіслати запит' }).count(),
        ask: await card.locator('button', { hasText: 'Попросити' }).count(),
        searching: await page.getByText('Шукаю…').count(),
        overflow: await sidewaysOverflow(page),
      }).toEqual({
        status: 409,
        code: 'LOAN_COPY_UNAVAILABLE',
        shown: true,
        announced: 1,
        inSheet: closing.size.width >= 768 ? 0 : 1,
        cards: 1,
        send: 0,
        ask: 0,
        searching: 0,
        overflow: 0,
      })
      await screenshot(
        page,
        `catalog-request-unavailable-${closing.size.name}-light`,
        closing.size.width >= 768,
      )

      const reread = page.waitForResponse(
        (response) => isDiscovery(response.request()) && response.ok(),
      )

      if (closing.by === 'Escape') await page.keyboard.press('Escape')
      else if (closing.by === '✕ шторки')
        await page.getByRole('dialog').locator('[data-slot="sheet-close"]').click()
      else await outcome.getByRole('button', { name: 'Закрити' }).click()

      await reread
      await card.waitFor({ state: 'detached' })
      await page
        .getByText('Серед ваших книжок і книжок друзів доступних примірників не знайшлося.')
        .waitFor()

      expect({
        // The list was not read while the explanation was open — only once it was closed.
        reads: reads.length - readsBefore,
        posts: posts.length,
        dialogs: await page.getByRole('dialog').count(),
        overflow: await sidewaysOverflow(page),
      }).toEqual({ reads: 1, posts: 1, dialogs: 0, overflow: 0 })
    })
  }
})
