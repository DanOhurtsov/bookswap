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
import { LoanService } from '../../src/loans/loan.service'
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { actOnLoan, befriend, requestLoan, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-147: АВТОМАТИЧНИЙ браузерний e2e секції «Потребує вашої дії» на головній. Реальні web (`next dev`)
 * і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium, синтетичні акаунти,
 * дружби, книжки й запити на позичання, створені через API. Відповіді продуктового API не підмінено.
 *
 * Підстановки, і лише такі:
 * - час запиту (`Loan.requestedAt`, `createdAt`) виставляється в БД, щоб порядок не залежав від швидкості
 *   запитів;
 * - сценарій помилки: читання списку браузер обриває на рівні мережі (`route.abort`), повтор іде до
 *   справжнього API; завантаження — справжній запит, затриманий у браузері;
 * - «інша вкладка» у сценарії конфлікту — виклик API від імені власника поза браузером.
 *
 * `BROWSER_SCREENSHOT_DIR` (необовʼязково) — куди покласти знімки для ручного перегляду.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser`. Без Chromium тест ПАДАЄ (не пропускається).
 */

const THEMES = ['light', 'dark'] as const
const SECTION = 'Потребує вашої дії'
const LIST_PATH = '/api/v1/loans'
const HOUR_MS = 60 * 60 * 1000

let app: INestApplication<App>
let prisma: PrismaService
let browser: Browser
let web: ChildProcess | undefined
let sequence = 0
const contexts: BrowserContext[] = []

interface Reader extends Account {
  email: string
}

interface Asked {
  loanId: string
  copyId: string
  title: string
}

interface Inbox {
  owner: Reader
  borrowers: Reader[]
  /** In the order of the section: newest first. */
  asked: Asked[]
}

beforeAll(async () => {
  app = await createTestApp()
  prisma = app.get(PrismaService)
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

/** A request for `copyId`, sent `hoursAgo` hours back. */
async function ask(
  borrower: Reader,
  copyId: string,
  title: string,
  hoursAgo: number,
  body: Record<string, unknown> = {},
): Promise<Asked> {
  const created = await requestLoan(app, borrower, copyId, body).expect(201)
  const loanId = (created.body as { loan: { id: string } }).loan.id
  const at = new Date(Date.now() - hoursAgo * HOUR_MS - 60_000)

  await prisma.loan.update({ where: { id: loanId }, data: { createdAt: at, requestedAt: at } })

  return { loanId, copyId, title }
}

/** The day `days` from today, as the API takes a return date. */
function dayFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * HOUR_MS).toISOString().slice(0, 10)
}

/** «2026-11-15» → «15.11.26», as the card writes it. */
function shortDate(day: string): string {
  const [year, month, date] = day.split('-')

  return `${date!}.${month!}.${year!.slice(2)}`
}

/**
 * An owner with `count` requests on their books from two friends, one an hour, newest first. The first
 * proposes a return date and writes a message; the second has a very long title.
 */
async function inboxOf(prefix: string, count: number): Promise<Inbox> {
  const owner = await registerReader(`${prefix}-o`, 'Власниця')
  const borrowers = [
    await registerReader(`${prefix}-1`, 'Ірина'),
    await registerReader(`${prefix}-2`, 'Тарас'),
  ]

  for (const borrower of borrowers) await befriend(app, owner, borrower)

  const asked: Asked[] = []

  for (let index = 0; index < count; index += 1) {
    const title =
      index === 1
        ? `Дуже довга назва книжки, яка не вміщається в один рядок картки ${prefix}`
        : `Запит ${String(index + 1)} ${prefix}`
    const copyId = await addBook(owner, title)
    const body =
      index === 0
        ? { proposedDueAt: dayFromNow(30), message: 'Давно хотіла перечитати — поверну вчасно!' }
        : {}

    asked.push(await ask(borrowers[index % 2]!, copyId, title, index + 2, body))
  }

  return { owner, borrowers, asked }
}

async function newPage(width = 1440, theme: (typeof THEMES)[number] = 'light'): Promise<Page> {
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

const isListRead = (address: URL) =>
  address.pathname === LIST_PATH &&
  address.searchParams.get('role') === 'owner' &&
  address.searchParams.get('status') === 'REQUESTED'

/** Every read of the requests list the page sends. */
function watchListReads(page: Page): string[] {
  const seen: string[] = []

  page.on('request', (sent: Request) => {
    const address = new URL(sent.url())

    if (isListRead(address)) seen.push(`${sent.method()} ${address.pathname}${address.search}`)
  })

  return seen
}

function section(page: Page): Locator {
  return page.getByRole('region', { name: SECTION })
}

function cards(page: Page): Locator {
  return section(page).getByRole('article')
}

function card(page: Page, title: string): Locator {
  return section(page).getByRole('article', { name: title })
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

/** How the cards are laid out. */
async function layoutOf(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('.incoming-requests__list')!.getBoundingClientRect()
    const articles = [...document.querySelectorAll('.incoming-request')]
    const boxes = articles.map((article) => article.getBoundingClientRect())
    const first = articles[0]!
    const box = (selector: string) => first.querySelector(selector)!.getBoundingClientRect()
    const cover = box('.incoming-request__cover')
    const approve = box('.incoming-request__actions > button')
    const width = document.documentElement.clientWidth

    return {
      pageOverflow: document.documentElement.scrollWidth - width,
      cardWidths: [...new Set(boxes.map((each) => Math.round(each.width)))],
      rows: new Set(boxes.map((each) => Math.round(each.top))).size,
      toEdges: Math.round(list.left) === 0 && Math.round(list.right) === width,
      firstLeft: Math.round(boxes[0]!.left) - Math.round(list.left),
      cover: `${String(Math.round(cover.width))}x${String(Math.round(cover.height))}`,
      // The answers beside the book (a tablet's row) or below it.
      actionsBeside: approve.top < cover.bottom && approve.left > cover.right,
      // Any descendant that runs past its card and is not clipped on the way: a title or a name that
      // neither wrapped nor truncated.
      overflowingCards: articles.filter((article) => {
        const outer = article.getBoundingClientRect()
        const clipped = (element: Element): boolean => {
          for (let up = element.parentElement; up !== null && up !== article; up = up.parentElement)
            if (getComputedStyle(up).overflowX !== 'visible') return true

          return false
        }

        return [...article.querySelectorAll('*')].some(
          (child) => child.getBoundingClientRect().right > outer.right + 0.5 && !clipped(child),
        )
      }).length,
    }
  })
}

describe('BS-147: «Потребує вашої дії» на головній (браузер)', () => {
  it('гість: секції немає, і список запитів не просить ні браузер, ні сервер', async () => {
    const spy = jest.spyOn(app.get(LoanService), 'list')

    try {
      const page = await newPage()
      const reads = watchListReads(page)

      await page.goto(`${WEB_ORIGIN}/`)
      await page.getByRole('heading', { name: 'BookSwap', level: 1 }).waitFor()
      await page.waitForLoadState('networkidle')

      expect(await section(page).count()).toBe(0)
      expect(await page.getByText(SECTION).count()).toBe(0)
      expect(reads).toEqual([])
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('порожньо: «Усе опрацьовано», без лічильника; на телефоні посилання — «Усі»', async () => {
    const owner = await registerReader('bs147-req-none', 'Спокійна')
    const page = await newPage(390)

    await login(page, owner.email)
    await section(page).getByText('Усе опрацьовано').waitFor()

    expect(await section(page).getByText('Нових запитів немає.').count()).toBe(1)
    expect(await section(page).locator('.incoming-requests__count').count()).toBe(0)
    expect(await page.getByText('Усі', { exact: true }).isVisible()).toBe(true)
    expect(
      await section(page).getByRole('link', { name: 'Переглянути всі' }).getAttribute('href'),
    ).toBe('/loans?role=owner')
    await screenshot(page, 'bs147-requests-empty-390-light')
  })

  it('завантаження, помилка з role="alert" без самоповтору і повтор, що приносить справжні картки', async () => {
    const { owner } = await inboxOf('bs147-req-err', 2)
    const page = await newPage()
    const reads = watchListReads(page)
    let release: () => void = () => undefined
    // Until the error is on screen every read fails at the network level: in `next dev` StrictMode
    // mounts the section twice and cancels the first read.
    let failing = true

    await page.route(
      (address) => isListRead(address),
      async (route) => {
        if (failing) {
          await route.abort('failed').catch(() => undefined)

          return
        }

        await new Promise<void>((resolve) => {
          release = resolve
        })
        await route.continue()
      },
    )

    await login(page, owner.email)

    const alert = section(page).getByRole('alert')

    await alert.waitFor()

    const sent = reads.length

    await page.waitForTimeout(1500)
    expect(reads).toHaveLength(sent)
    failing = false
    expect(await alert.textContent()).toContain('Не вдалося завантажити запити на ваші книжки.')
    await screenshot(page, 'bs147-requests-error-1440-light')

    await alert.getByRole('button', { name: 'Спробувати ще раз' }).click()
    await section(page).getByText('Шукаю запити на ваші книжки…').waitFor({ state: 'attached' })
    expect(await section(page).getAttribute('aria-busy')).toBe('true')
    await screenshot(page, 'bs147-requests-loading-1440-light')
    release()

    await cards(page).first().waitFor()
    expect(await cards(page).count()).toBe(2)
    expect(await section(page).getByRole('alert').count()).toBe(0)
    expect(reads).toHaveLength(sent + 1)
  })

  // Three cards side by side on a desktop (canvas: thirds of the 1120 px container with 16 px gaps), a
  // row per request on a tablet, 300 px cards in a rail to the screen's edges on a phone.
  const LAYOUTS = [
    { width: 1440, card: 363, rows: 1, toEdges: false, first: 0, cover: '56x84', beside: false },
    { width: 834, card: 786, rows: 3, toEdges: false, first: 0, cover: '48x72', beside: true },
    { width: 390, card: 300, rows: 1, toEdges: true, first: 16, cover: '48x72', beside: false },
  ] as const

  for (const theme of THEMES) {
    it(`картки на 1440/834/390, ${theme} тема: три новіші з п’яти, лічильник, вміст картки, без горизонтального скролу`, async () => {
      const { owner, borrowers, asked } = await inboxOf(`bs147-req-${theme}`, 5)

      for (const layout of LAYOUTS) {
        const page = await newPage(layout.width, theme)

        await login(page, owner.email)
        await ready(page)
        await screenshot(page, `bs147-requests-${String(layout.width)}-${theme}`)

        const shown = await layoutOf(page)

        expect({ width: layout.width, ...shown }).toMatchObject({
          width: layout.width,
          pageOverflow: 0,
          cardWidths: [layout.card],
          rows: layout.rows,
          toEdges: layout.toEdges,
          firstLeft: layout.first,
          cover: layout.cover,
          actionsBeside: layout.beside,
          overflowingCards: 0,
        })
        expect(await cards(page).count()).toBe(3)
        expect(
          await section(page).locator('.incoming-requests__count [aria-hidden="true"]').innerText(),
        ).toBe('5')
        expect(await page.getByText('Усі', { exact: true }).isVisible()).toBe(layout.width < 768)
        // The borrower's words: on a desktop only, as the canvas draws them.
        expect(
          await card(page, asked[0]!.title).locator('.incoming-request__message').isVisible(),
        ).toBe(layout.width >= 1024)
      }

      const page = await newPage(1440, theme)

      await login(page, owner.email)
      await ready(page)

      // Newest first; each card names who asks, when, what, until when and what they wrote.
      expect(
        await cards(page).evaluateAll((articles) =>
          articles.map((article) => article.querySelector('a')?.textContent),
        ),
      ).toEqual(asked.slice(0, 3).map((each) => each.title))

      const first = card(page, asked[0]!.title)
      const due = dayFromNow(30)

      expect(await first.getByText(borrowers[0]!.displayName).count()).toBe(1)
      expect(await first.getByText('2 год тому').count()).toBe(1)
      expect(await first.getByText('Новий запит').count()).toBe(1)
      expect(await first.getByText(`Поверне до ${shortDate(due)}`).count()).toBe(1)
      expect(await first.locator('time[datetime]').nth(1).getAttribute('datetime')).toBe(due)
      expect(await first.getByText('«Давно хотіла перечитати — поверну вчасно!»').count()).toBe(1)
      expect(await first.getByRole('link').getAttribute('href')).toBe(
        `/loans?loanId=${asked[0]!.loanId}`,
      )
      expect(
        await card(page, asked[1]!.title)
          .getByText(/Поверне до/)
          .count(),
      ).toBe(0)

      // The badge takes the theme's warning colours.
      expect(
        await first
          .getByText('Новий запит')
          .evaluate((badge) => getComputedStyle(badge).backgroundColor),
      ).toBe(theme === 'light' ? 'rgb(255, 241, 217)' : 'rgb(58, 44, 18)')
    })
  }

  it('«Погодити» з датою й відповіддю → картка зникає; /loans показує домовленість; відмова на /loans і повернення назад без перезавантаження показують свіжий список', async () => {
    const { owner, asked } = await inboxOf('bs147-req-approve', 2)
    const page = await newPage(1440, 'light')
    const reads = watchListReads(page)

    await login(page, owner.email)
    await ready(page)

    const target = card(page, asked[0]!.title)

    await target.getByRole('button', { name: 'Погодити' }).click()

    const due = target.getByLabel('Повернути до')

    expect(await due.inputValue()).toBe(dayFromNow(30))
    expect(await due.evaluate((field) => field === document.activeElement)).toBe(true)
    await due.fill(dayFromNow(21))
    await target.getByLabel('Відповідь').fill('Забирай у суботу')
    await screenshot(page, 'bs147-requests-approving-1440-light')
    await target.getByRole('button', { name: 'Погодити' }).click()

    await target.waitFor({ state: 'detached' })
    expect(await section(page).getByRole('status').textContent()).toBe(
      `Запит на «${asked[0]!.title}» погоджено.`,
    )
    expect(
      await section(page).locator('.incoming-requests__count [aria-hidden="true"]').innerText(),
    ).toBe('1')

    const approved = await request(app.getHttpServer())
      .get(url(`/loans/${asked[0]!.loanId}`))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(approved.body).toMatchObject({
      loan: { status: 'APPROVED', dueAt: dayFromNow(21), responseNote: 'Забирай у суботу' },
    })

    // To /loans and back inside the app: the page is never reloaded.
    await page.evaluate(() => {
      ;(window as unknown as { sameDocument: boolean }).sameDocument = true
    })
    await section(page).getByRole('link', { name: 'Переглянути всі' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/loans?role=owner`)

    const lent = page.locator('li.book', { hasText: asked[0]!.title })
    const waiting = page.locator('li.book', { hasText: asked[1]!.title })

    await lent.getByText(/Домовлено, ще не передано/).waitFor()
    await waiting.getByRole('button', { name: 'Відмовити' }).click()
    await waiting.getByText(/Відмовлено/).waitFor()

    const readsBefore = reads.length

    await page.goBack()
    await page.waitForURL(`${WEB_ORIGIN}/`)
    await section(page).getByText('Усе опрацьовано').waitFor()

    expect(
      await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument),
    ).toBe(true)
    expect(reads.length).toBeGreaterThan(readsBefore)
  })

  it('клавіатура: Enter на «Погодити» ставить фокус у дату, Escape повертає його; «Відмовити» відхиляє, і фокус переходить на заголовок секції', async () => {
    const { owner, asked } = await inboxOf('bs147-req-keys', 2)
    const page = await newPage(1440, 'dark')

    await login(page, owner.email)
    await ready(page)

    const target = card(page, asked[0]!.title)
    const approve = target.getByRole('button', { name: 'Погодити' })
    const isFocused = (locator: Locator) =>
      locator.evaluate((element) => element === document.activeElement)

    // Real Tab presses from the top of the page: a programmatic focus would not be `:focus-visible`.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    for (let step = 0; step < 60 && !(await isFocused(approve)); step += 1)
      await page.keyboard.press('Tab')

    expect(await isFocused(approve)).toBe(true)
    expect(await approve.evaluate((button) => button.matches(':focus-visible'))).toBe(true)
    await screenshot(page, 'bs147-requests-focus-1440-dark')

    await page.keyboard.press('Enter')
    expect(await isFocused(target.getByLabel('Повернути до'))).toBe(true)

    await page.keyboard.press('Escape')
    expect(await target.getByLabel('Повернути до').count()).toBe(0)
    expect(await isFocused(approve)).toBe(true)

    await page.keyboard.press('Tab')
    expect(await isFocused(target.getByRole('button', { name: 'Відмовити' }))).toBe(true)
    await page.keyboard.press('Enter')

    await target.waitFor({ state: 'detached' })
    expect(await section(page).getByRole('status').textContent()).toBe(
      `Запит на «${asked[0]!.title}» відхилено.`,
    )
    expect(await isFocused(page.getByRole('heading', { name: SECTION, level: 2 }))).toBe(true)

    const rejected = await request(app.getHttpServer())
      .get(url(`/loans/${asked[0]!.loanId}`))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(rejected.body).toMatchObject({ loan: { status: 'REJECTED' } })
  })

  it('конфлікт: запит уже опрацьовано на сервері → 409 → список перечитано один раз, застарілі картки зникли, лічильник оновився, пояснення лишилося', async () => {
    const owner = await registerReader('bs147-req-409-o', 'Власниця')
    const first = await registerReader('bs147-req-409-1', 'Ірина')
    const second = await registerReader('bs147-req-409-2', 'Тарас')

    await befriend(app, owner, first)
    await befriend(app, owner, second)

    const title = 'Одна книжка на двох bs147'
    const copyId = await addBook(owner, title)
    const mine = await ask(first, copyId, title, 3)
    const theirs = await ask(second, copyId, title, 2)
    const otherTitle = 'Інша книжка bs147'
    const other = await ask(first, await addBook(owner, otherTitle), otherTitle, 1)
    const page = await newPage(1440, 'light')
    const reads = watchListReads(page)
    const patches: string[] = []

    page.on('request', (sent: Request) => {
      if (sent.method() === 'PATCH') patches.push(new URL(sent.url()).pathname)
    })

    await login(page, owner.email)
    await ready(page)
    expect(await cards(page).count()).toBe(3)
    expect(
      await section(page).locator('.incoming-requests__count [aria-hidden="true"]').innerText(),
    ).toBe('3')

    const stale = cards(page).nth(2)
    const readsBefore = reads.length

    await stale.getByRole('button', { name: 'Погодити' }).click()

    // Another tab approves the other request: this one is turned down by the server on its own.
    await actOnLoan(app, owner, theirs.loanId, { action: 'approve' }).expect(200)
    await stale.getByRole('button', { name: 'Погодити' }).click()

    // The list is read again: both stale cards leave, the one still waiting stays.
    await page.waitForFunction(() => document.querySelectorAll('.incoming-request').length === 1)
    expect(await card(page, otherTitle).count()).toBe(1)
    expect(
      await section(page).locator('.incoming-requests__count [aria-hidden="true"]').innerText(),
    ).toBe('1')
    expect(await section(page).getByText('1 запит', { exact: true }).count()).toBe(1)

    // The explanation is the section's, and it stays; no success is announced.
    const alert = section(page).getByRole('alert')

    expect(await alert.count()).toBe(1)
    expect(await alert.innerText()).toBe(
      `Не вдалося відповісти на запит на «${title}». Дія неможлива в поточному стані позичання`,
    )
    expect(await alert.isVisible()).toBe(true)
    expect(await section(page).getByRole('status').textContent()).toBe('')
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(SECTION)
    await screenshot(page, 'bs147-requests-conflict-1440-light')

    // One PATCH, one read after it, and nothing more on its own.
    await page.waitForTimeout(1500)
    expect(patches).toEqual([`${LIST_PATH}/${mine.loanId}`])
    expect(reads.length - readsBefore).toBe(1)
    expect(await alert.isVisible()).toBe(true)

    const untouched = await request(app.getHttpServer())
      .get(url(`/loans/${mine.loanId}`))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(untouched.body).toMatchObject({ loan: { status: 'REJECTED', responseNote: null } })

    const waiting = await request(app.getHttpServer())
      .get(url(`/loans/${other.loanId}`))
      .set('Cookie', owner.cookie)
      .expect(200)

    expect(waiting.body).toMatchObject({ loan: { status: 'REQUESTED' } })
  })

  it('форма погодження на планшеті й телефоні: поля в межах картки, без горизонтального скролу', async () => {
    const { owner, asked } = await inboxOf('bs147-req-form', 2)

    for (const width of [834, 390]) {
      const page = await newPage(width, 'light')

      await login(page, owner.email)
      await ready(page)
      await card(page, asked[0]!.title).getByRole('button', { name: 'Погодити' }).click()
      await card(page, asked[0]!.title).getByLabel('Відповідь').waitFor()
      await screenshot(page, `bs147-requests-approving-${String(width)}-light`)

      const shown = await layoutOf(page)

      expect({ width, pageOverflow: shown.pageOverflow, overflow: shown.overflowingCards }).toEqual(
        { width, pageOverflow: 0, overflow: 0 },
      )
    }
  })

  it('текст 200 %: без горизонтального скролу, вміст карток у їхніх межах', async () => {
    const { owner } = await inboxOf('bs147-req-zoom', 3)

    for (const width of [1440, 834]) {
      const page = await newPage(width, 'light')

      await login(page, owner.email)
      await ready(page)
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
      await page.waitForLoadState('networkidle')
      await screenshot(page, `bs147-requests-text200-${String(width)}-light`)

      const shown = await layoutOf(page)

      expect({ width, pageOverflow: shown.pageOverflow, overflow: shown.overflowingCards }).toEqual(
        { width, pageOverflow: 0, overflow: 0 },
      )
    }
  })

  it('довге ім’я й назва на 120 літер: картка не ширшає, обидві відповіді в її межах; на desktop назва — максимум три рядки, повна — у DOM і в імені посилання; аватар — пастель за першою літерою', async () => {
    const owner = await registerReader('bs147-req-long-o', 'Власниця')
    const borrower = await registerReader(
      'bs147-req-long-b',
      'Олександра-Вікторія Шевченко-Коваленко-Підгірна',
    )

    await befriend(app, owner, borrower)

    const title =
      'Неймовірно довга назва книжки про подорож крізь усі області України від Ужгорода до Харкова й назад через Карпати bs147'.slice(
        0,
        120,
      )

    await ask(borrower, await addBook(owner, title), title, 2)

    for (const layout of LAYOUTS) {
      const page = await newPage(layout.width, 'light')

      await login(page, owner.email)
      await ready(page)
      await screenshot(page, `bs147-requests-long-${String(layout.width)}-light`)

      const shown = await layoutOf(page)
      const answersInside = await cards(page)
        .first()
        .evaluate((article) => {
          const outer = article.getBoundingClientRect()

          return [...article.querySelectorAll('button')].every((button) => {
            const box = button.getBoundingClientRect()

            return box.left >= outer.left && box.right <= outer.right + 0.5
          })
        })

      expect({
        width: layout.width,
        pageOverflow: shown.pageOverflow,
        cardWidths: shown.cardWidths,
        overflowingCards: shown.overflowingCards,
        answersInside,
      }).toEqual({
        width: layout.width,
        pageOverflow: 0,
        cardWidths: [layout.card],
        overflowingCards: 0,
        answersInside: true,
      })

      // Clipped on a desktop only, never cut from the page: the link and the card are named by all of it.
      const titleShown = await cards(page)
        .first()
        .locator('.incoming-request__title')
        .evaluate((link) => {
          const style = getComputedStyle(link)

          return {
            lines: Math.round(link.getBoundingClientRect().height / parseFloat(style.lineHeight)),
            clipped: link.scrollHeight > link.clientHeight + 1,
            text: link.textContent,
          }
        })

      expect({ width: layout.width, ...titleShown }).toEqual({
        width: layout.width,
        lines: layout.width === 1440 ? 3 : (expect.any(Number) as number),
        clipped: layout.width === 1440,
        text: title,
      })
      expect(await section(page).getByRole('link', { name: title, exact: true }).count()).toBe(1)
      expect(await section(page).getByRole('article', { name: title, exact: true }).count()).toBe(1)

      // «Олександра…» — «О», the canvas's lavender.
      expect(
        await cards(page)
          .first()
          .locator('[data-slot="avatar-fallback"]')
          .evaluate((fallback) => {
            const style = getComputedStyle(fallback)
            return [style.backgroundColor, style.color]
          }),
      ).toEqual(['rgb(236, 226, 242)', 'rgb(94, 59, 120)'])
    }
  })

  it('A → вихід → B у тій самій вкладці: B ніколи не бачить запитів на книжки A', async () => {
    const a = await inboxOf('bs147-req-switch', 2)
    const b = await registerReader('bs147-req-switch-b', 'Інша людина')
    const page = await newPage()

    await page.addInitScript(() => {
      const frames: string[] = []

      ;(window as unknown as { requestFrames: string[] }).requestFrames = frames
      new MutationObserver(() => {
        frames.push(document.querySelector('main')?.textContent ?? '')
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })

    await login(page, a.owner.email)
    await ready(page)

    await page.getByRole('button', { name: /Відкрити меню профілю/ }).click()
    await page.getByRole('menuitem', { name: 'Вийти' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/login`)

    const before = await page.evaluate(
      () => (window as unknown as { requestFrames: string[] }).requestFrames.length,
    )

    await login(page, b.email)
    await section(page).getByText('Усе опрацьовано').waitFor()

    const framesForB = await page.evaluate(
      (from) => (window as unknown as { requestFrames: string[] }).requestFrames.slice(from),
      before,
    )
    const titlesOfA = a.asked.map((each) => each.title)

    expect(framesForB.filter((frame) => titlesOfA.some((title) => frame.includes(title)))).toEqual(
      [],
    )
  })
})
