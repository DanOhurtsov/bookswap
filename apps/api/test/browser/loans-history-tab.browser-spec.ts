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
} from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { PrismaService } from '../../src/prisma/prisma.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import {
  actOnLoan,
  befriend,
  createShelfCopy,
  handedOverLoan,
  requestLoan,
  url,
  type Account,
  type Shelf,
} from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-143 + BS-142: AUTOMATED browser e2e of the personal history — the third tab of «Позичання» and,
 * since BS-142, one shared list of both directions. Not manual QA. Real web (`next dev`) and API
 * (`createTestApp` in this process) over the test database, real Chromium, synthetic accounts only.
 * Nothing is substituted: no API, no router, no data source.
 *
 * Path: header → «Моя бібліотека» → «Позичання» → «Історія» → one list ordered by ending → reload, all
 * with the URL as the state; a direct open of the new address and of an old `historyView` one; the old
 * `/history` address (server 307, signed in and as a guest); an old `?loanId=` link; desktop and mobile
 * width with the keyboard in light and dark, with a long title and a long name.
 *
 * `BROWSER_SCREENSHOT_DIR` (optional) — where to put screenshots for a manual look.
 *
 * Run: `pnpm --filter @bookswap/api test:browser`. Without Chromium the test FAILS (it is not skipped).
 */

const THEMES = ['light', 'dark'] as const

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let prisma: PrismaService
const contexts: BrowserContext[] = []

interface Person extends Account {
  email: string
}

interface Book {
  title: string
  shelf: Shelf
}

/** One reader with every kind of history entry, seeded once through the API. */
interface World {
  me: Person
  friend: Person
  alias: string
  /** My book the friend borrowed and returned — twice: two separate «Ви дали почитати» rows. */
  lent: Book & { loanId: string }
  /** The friend's book (a long title) I borrowed and returned between those two loans. */
  borrowed: Book
  /** My book handed to a guest: an anonymous row without an ending. */
  guest: Book
  /** A request still open on my book: in history too, below everything that ended. */
  requested: Book
}

/** BS-142: the order the shared list must show — endings first (newest first), then the rest. */
const expectedTitles = (): string[] => [
  world.lent.title,
  world.borrowed.title,
  world.lent.title,
  world.requested.title,
  world.guest.title,
]

let world: World

beforeAll(async () => {
  app = await createTestApp()
  prisma = app.get(PrismaService)
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
  world = await seedWorld()
}, 240_000)

// Each test's browser contexts close with it: renderers of finished tests are not kept alive.
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close().catch(() => undefined)
})

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

async function register(prefix: string, name: string): Promise<Person> {
  const email = uniqueEmail(prefix)
  const displayName = `${name} ${String(process.pid)}`.slice(0, 80)
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

async function book(owner: Account): Promise<Book> {
  const shelf = await createShelfCopy(app, owner)
  const { title } = await prisma.work.findUniqueOrThrow({
    where: { id: shelf.workId },
    select: { title: true },
  })

  return { title, shelf }
}

async function lendAndReturn(owner: Person, borrower: Person, copyId: string): Promise<string> {
  const loanId = await handedOverLoan(app, owner, borrower, copyId)

  await actOnLoan(app, owner, loanId, { action: 'return' }).expect(200)

  return loanId
}

/** A long title with ordinary words: it must wrap inside the card, never widen the page. */
const LONG_TITLE =
  'Надзвичайно довга назва твору про бібліотеку, позичання й повернення книжок між друзями, ' +
  'яка не вміщується в один рядок навіть на широкому екрані'

async function seedWorld(): Promise<World> {
  const me = await register('bs143-me', 'Читачка')
  const friend = await register(
    'bs143-friend',
    'Друг Із Дуже Довгим Імʼям Костянтин-Олександр Вишневецький-Подільський',
  )

  await befriend(app, me, friend)

  const lent = await book(me)
  const lentLoanId = await lendAndReturn(me, friend, lent.shelf.copyId)

  const borrowed = await book(friend)

  await prisma.work.update({
    where: { id: borrowed.shelf.workId },
    data: { title: `${LONG_TITLE} ${String(process.pid)}` },
  })
  borrowed.title = `${LONG_TITLE} ${String(process.pid)}`
  await lendAndReturn(friend, me, borrowed.shelf.copyId)

  // The same copy again: a repeated loan is its own row, never merged with the first one.
  await lendAndReturn(me, friend, lent.shelf.copyId)

  const alias = `Аліас bs143 ${String(Date.now())}`
  const contact = await request(app.getHttpServer())
    .post(url('/me/external-borrowers'))
    .set('Cookie', me.cookie)
    .send({ alias, ownerInformed: true })
    .expect(201)
  const guest = await book(me)

  await request(app.getHttpServer())
    .post(url('/loans/guest'))
    .set('Cookie', me.cookie)
    .send({
      copyId: guest.shelf.copyId,
      externalBorrowerId: (contact.body as { contact: { id: string } }).contact.id,
      handedAt: '2026-01-01',
    })
    .expect(201)

  const requested = await book(me)

  await requestLoan(app, friend, requested.shelf.copyId).expect(201)

  return {
    me,
    friend,
    alias,
    lent: { ...lent, loanId: lentLoanId },
    borrowed,
    guest,
    requested,
  }
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

/**
 * A fresh tab signed in by the session cookie, whose first navigation is `path` — a direct open.
 *
 * Fresh rather than another `goto` in a used tab: a full navigation away from a loaded page crashes
 * the headless Chromium renderer in WSL on any route (`/library` → `/wishlist` too), not only here.
 */
async function openSignedIn(person: Person, path: string): Promise<Page> {
  const tab = await newPage()
  const separator = person.cookie.indexOf('=')

  await tab.context().addCookies([
    {
      name: person.cookie.slice(0, separator),
      value: person.cookie.slice(separator + 1),
      url: WEB_ORIGIN,
    },
  ])
  await tab.goto(`${WEB_ORIGIN}${path}`)

  return tab
}

/** Every loans/history read the page sends, as a path with its query. */
function watchReads(page: Page): string[] {
  const seen: string[] = []

  page.on('request', (sent) => {
    const address = new URL(sent.url())

    if (
      sent.method() === 'GET' &&
      (address.pathname.startsWith('/api/v1/loans') || address.pathname === '/api/v1/me/history')
    )
      seen.push(`${address.pathname}${address.search}`)
  })

  return seen
}

const loansTabs = (page: Page): Locator =>
  page.getByRole('tablist', { name: 'Вкладки позичань' }).getByRole('tab')
/** The rows of the one shared history list. */
const historyRows = (page: Page): Locator =>
  page.getByRole('list', { name: 'Історія позичань' }).getByRole('listitem')
const sectionNav = (page: Page): Locator =>
  page.getByRole('navigation', { name: 'Розділи бібліотеки' })

/** Waits until this tab is the selected one of its tablist. */
async function expectSelected(tab: Locator): Promise<void> {
  await tab.and(tab.page().locator('[aria-selected="true"]')).waitFor()
}

/** The rows of a title in the history list, in list order (a repeated loan gives several). */
function card(where: Page, title: string): Locator {
  return historyRows(where).filter({
    has: where.getByRole('link', { name: title, exact: true }),
  })
}

/** Each row's title — the first link of the row — in list order. */
async function rowTitles(where: Page): Promise<string[]> {
  await historyRows(where).first().waitFor()

  return historyRows(where).evaluateAll((items) =>
    items.map((item) => item.querySelector('a')?.textContent ?? ''),
  )
}

/** A marker on `window` survives only client-side navigation: proof that nothing reloaded. */
async function markWindow(where: Page): Promise<void> {
  await where.evaluate(() => {
    ;(window as unknown as { bs143?: boolean }).bs143 = true
  })
}

async function isSameWindow(where: Page): Promise<boolean> {
  return where.evaluate(() => (window as unknown as { bs143?: boolean }).bs143 === true)
}

async function screenshot(where: Page, name: string): Promise<void> {
  const directory = process.env.BROWSER_SCREENSHOT_DIR

  if (directory !== undefined)
    await where.screenshot({ path: join(directory, `${name}.png`), animations: 'disabled' })
}

/** Presses Tab until `target` holds focus; fails if it never does. */
async function tabTo(where: Page, target: Locator): Promise<void> {
  for (let step = 0; step < 40; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return

    await where.keyboard.press('Tab')
  }

  throw new Error('Фокус так і не дійшов до потрібного елемента')
}

describe('BS-143/BS-142: особиста історія — третя вкладка «Позичань», один список (браузер)', () => {
  it('хедер → «Позичання» → «Історія» → спільний список за датою завершення → reload: стан в адресі, рамка одна', async () => {
    const tab = await newPage()
    const reads = watchReads(tab)

    await login(tab, world.me.email)

    await tab.getByRole('link', { name: 'Моя бібліотека', exact: true }).first().click()
    await tab.waitForURL(`${WEB_ORIGIN}/library`)
    await sectionNav(tab).getByRole('link', { name: 'Позичання' }).click()
    await tab.waitForURL(`${WEB_ORIGIN}/loans`)

    expect(await sectionNav(tab).getByRole('link').allTextContents()).toEqual([
      'Книжки',
      'Позичання',
      'Вішлист',
    ])
    expect(await loansTabs(tab).allTextContents()).toEqual(['Мої книжки', 'Я позичаю', 'Історія'])
    await expectSelected(loansTabs(tab).filter({ hasText: 'Мої книжки' }))

    // The current loans: an open request with its actions, not history.
    const requestCard = tab
      .getByRole('listitem')
      .filter({ has: tab.getByRole('link', { name: world.requested.title, exact: true }) })

    await requestCard.getByRole('button', { name: 'Погодити' }).waitFor()
    await tab.waitForLoadState('networkidle')
    await markWindow(tab)

    const beforeHistory = reads.length

    await loansTabs(tab).filter({ hasText: 'Історія' }).click()
    await tab.waitForURL(`${WEB_ORIGIN}/loans?tab=history`)
    await expectSelected(loansTabs(tab).filter({ hasText: 'Історія' }))

    // One list, no inner tabs; both directions mixed by ending, the rest below.
    expect(await rowTitles(tab)).toEqual(expectedTitles())
    expect(await tab.getByRole('tablist').count()).toBe(1)

    const [lentAgain, lentFirst] = [
      card(tab, world.lent.title).nth(0),
      card(tab, world.lent.title).nth(1),
    ]

    for (const row of [lentAgain, lentFirst]) {
      expect(await row.innerText()).toContain(
        `Ви дали почитати · Позичальник: ${world.friend.displayName}`,
      )
      expect(await row.innerText()).toContain('Статус: Повернено')
    }

    const borrowedCard = card(tab, world.borrowed.title)

    expect(await borrowedCard.innerText()).toContain(
      `Ви позичили · Власник: ${world.friend.displayName}`,
    )
    expect(await borrowedCard.innerText()).toMatch(/Передано: .+ · Повернено: .+/)
    expect(
      await borrowedCard
        .getByRole('link', { name: world.borrowed.title, exact: true })
        .getAttribute('href'),
    ).toBe(`/works/${world.borrowed.shelf.workId}`)
    expect(
      await borrowedCard.getByRole('link', { name: 'Уся історія примірника' }).getAttribute('href'),
    ).toBe(`/copies/${world.borrowed.shelf.copyId}/history`)

    expect(await card(tab, world.requested.title).innerText()).toContain(
      'Статус: Чекає на відповідь',
    )
    expect(await card(tab, world.requested.title).innerText()).toContain(
      'Передано: не вказано · Повернено: не вказано',
    )

    // One frame: «Моя бібліотека» stays current in the header, «Позичання» in the section.
    expect(await tab.getByRole('heading', { level: 1 }).allTextContents()).toEqual([
      'Моя бібліотека',
    ])
    expect(await tab.getByRole('main').count()).toBe(1)
    expect(
      await sectionNav(tab).getByRole('link', { name: 'Позичання' }).getAttribute('aria-current'),
    ).toBe('page')
    expect(
      await tab
        .getByRole('link', { name: 'Моя бібліотека', exact: true })
        .first()
        .getAttribute('aria-current'),
    ).toBe('page')

    // The guest entry stays anonymous: no alias anywhere on the page, not even in the markup.
    const guestCard = card(tab, world.guest.title)

    expect(await guestCard.innerText()).toContain('Позичальник: гість, ім’я не показується')
    expect(await guestCard.innerText()).toContain('Записано власником · джерело: зі слів власника')
    expect(await tab.content()).not.toContain(world.alias)

    // History reads only `/me/history` — never the current loans list — and nothing reloaded.
    await tab.waitForLoadState('networkidle')
    expect(new Set(reads.slice(beforeHistory))).toEqual(new Set(['/api/v1/me/history']))
    expect(await isSameWindow(tab)).toBe(true)
    await screenshot(tab, 'bs142-history-1280-light')

    // Reload: the address keeps the tab and the list.
    await tab.reload()
    expect(await rowTitles(tab)).toEqual(expectedTitles())
    expect(tab.url()).toBe(`${WEB_ORIGIN}/loans?tab=history`)
    await expectSelected(loansTabs(tab).filter({ hasText: 'Історія' }))
    expect(await isSameWindow(tab)).toBe(false)

    // Back to a list tab: `tab` goes, `role` comes.
    await loansTabs(tab).filter({ hasText: 'Я позичаю' }).click()
    await tab.waitForURL(`${WEB_ORIGIN}/loans?role=borrower`)
    await expectSelected(loansTabs(tab).filter({ hasText: 'Я позичаю' }))
    // The returned loan is still on my borrower side — now as a current-loans card with its status.
    await tab
      .getByRole('tabpanel')
      .getByRole('link', { name: world.borrowed.title, exact: true })
      .waitFor()
    await tab.getByRole('combobox', { name: 'Статус' }).waitFor()
  })

  it('пряме відкриття: нова адреса й стара з historyView відкривають той самий спільний список', async () => {
    for (const query of [
      'tab=history',
      'tab=history&historyView=lent',
      'tab=history&historyView=borrowed',
    ]) {
      const opened = await openSignedIn(world.me, `/loans?${query}`)

      expect(await rowTitles(opened)).toEqual(expectedTitles())
      await expectSelected(loansTabs(opened).filter({ hasText: 'Історія' }))
      // The old parameter is neither applied nor rewritten.
      expect(opened.url()).toBe(`${WEB_ORIGIN}/loans?${query}`)
    }

    // An old link to one loan still opens that loan, even with `tab=history` beside it.
    const single = await openSignedIn(world.me, `/loans?loanId=${world.lent.loanId}&tab=history`)

    await single.getByRole('link', { name: 'Показати всі' }).waitFor()
    expect(await single.getByRole('link', { name: 'Показати всі' }).getAttribute('href')).toBe(
      '/loans?role=owner',
    )
    await single.getByRole('link', { name: world.lent.title, exact: true }).waitFor()
    expect(await single.getByRole('tablist').count()).toBe(0)
  })

  it('стара адреса /history: сервер відповідає 307 на /loans?tab=history без старого екрана й параметрів', async () => {
    const response = await fetch(`${WEB_ORIGIN}/history?historyView=lent&x=1`, {
      redirect: 'manual',
    })

    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location') ?? '', WEB_ORIGIN).href).toBe(
      `${WEB_ORIGIN}/loans?tab=history`,
    )
    expect(await response.text()).not.toContain('Що я брав')

    const tab = await newPage()

    await login(tab, world.me.email)

    const opened = await tab.goto(`${WEB_ORIGIN}/history?historyView=lent`)

    await tab.waitForURL(`${WEB_ORIGIN}/loans?tab=history`)
    expect(opened?.request().redirectedFrom()?.url()).toBe(`${WEB_ORIGIN}/history?historyView=lent`)
    expect(await rowTitles(tab)).toEqual(expectedTitles())

    // A guest: first the loans page, then its usual guard.
    const guest = await newPage()

    await guest.goto(`${WEB_ORIGIN}/history`)
    await guest.waitForURL((address) => address.pathname === '/login')
  })

  it('стара втрата без дати завершення, знайдена у вересні, стоїть вище червневої передачі', async () => {
    const me = await register('bs142-lost-me', 'Власниця')
    const friend = await register('bs142-lost-friend', 'Позичальник')

    await befriend(app, me, friend)

    const lost = await book(me)
    const active = await book(me)

    // A loss from before Stage 10: no LOAN_LOST was ever written (the REC5 fixture).
    const lostId = await handedOverLoan(app, me, friend, lost.shelf.copyId)

    await actOnLoan(app, me, lostId, { action: 'mark_lost' }).expect(200)
    await prisma.loanEvent.deleteMany({ where: { loanId: lostId } })
    await prisma.loan.update({
      where: { id: lostId },
      data: {
        createdAt: new Date('2026-01-01T00:00:00Z'),
        requestedAt: new Date('2026-01-01T00:00:00Z'),
        respondedAt: new Date('2026-01-02T00:00:00Z'),
        handedAt: new Date('2026-01-03T00:00:00Z'),
      },
    })

    const activeId = await handedOverLoan(app, me, friend, active.shelf.copyId)

    await prisma.loan.update({
      where: { id: activeId },
      data: {
        createdAt: new Date('2026-02-01T00:00:00Z'),
        requestedAt: new Date('2026-02-01T00:00:00Z'),
        respondedAt: new Date('2026-02-02T00:00:00Z'),
        handedAt: new Date('2026-06-01T00:00:00Z'),
      },
    })
    await actOnLoan(app, me, lostId, { action: 'recover', effectiveAt: '2026-09-01' }).expect(200)

    for (const person of [me, friend]) {
      const tab = await openSignedIn(person, '/loans?tab=history')

      expect(await rowTitles(tab)).toEqual([lost.title, active.title])

      // Ordered by the recovery, yet the loss keeps its unknown ending; no event data in the page.
      expect(await card(tab, lost.title).innerText()).toContain('Статус: Втрачено')
      expect(await card(tab, lost.title).innerText()).toContain('Завершено: не вказано')
      expect(await tab.content()).not.toMatch(/RECOVERED|effectiveAt|latestFactAt|payload/)
      await screenshot(tab, `bs142-history-recovered-${person === me ? 'owner' : 'borrower'}`)
    }
  })

  for (const width of [375, 1280]) {
    for (const theme of THEMES) {
      it(`${String(width)} px, ${theme} тема: клавіатурою до історії, видимий фокус, довгі назва й імʼя без горизонтального скролу`, async () => {
        const tab = await newPage({ width, theme })

        await login(tab, world.me.email)
        await tab.goto(`${WEB_ORIGIN}/loans`)
        await tab.getByRole('link', { name: world.requested.title, exact: true }).waitFor()
        await tab.waitForLoadState('networkidle')

        // The selected tab is the tablist's one Tab stop; arrows move, Enter chooses.
        const owner = loansTabs(tab).filter({ hasText: 'Мої книжки' })

        await tab.locator('body').focus()
        await tabTo(tab, owner)
        expect(
          await owner.evaluate((element) => {
            const style = getComputedStyle(element)

            return style.outlineStyle !== 'none' || style.boxShadow !== 'none'
          }),
        ).toBe(true)

        await tab.keyboard.press('ArrowRight')
        await tab.keyboard.press('ArrowRight')
        await tab.keyboard.press('Enter')
        await tab.waitForURL(`${WEB_ORIGIN}/loans?tab=history`)
        expect(await rowTitles(tab)).toEqual(expectedTitles())

        // From the tab into the list: the first row's title is reachable by keyboard and visibly focused.
        const firstTitle = historyRows(tab).first().getByRole('link').first()

        await tabTo(tab, firstTitle)
        expect(
          await firstTitle.evaluate((element) => {
            const style = getComputedStyle(element)

            return style.outlineStyle !== 'none' || style.boxShadow !== 'none'
          }),
        ).toBe(true)

        // The underline fades in: measure it once the transition has finished.
        await tab.waitForFunction(() => document.getAnimations().length === 0)
        await screenshot(tab, `bs142-history-${String(width)}-${theme}`)

        const layout = await tab.evaluate(() => {
          const viewport = document.documentElement.clientWidth
          const tabs = [...document.querySelectorAll('[role="tab"]')]
          const selected = tabs.filter(
            (element) => element.getAttribute('aria-selected') === 'true',
          )
          const underline = (element: Element): string =>
            getComputedStyle(element, '::after').opacity
          const rows = [...document.querySelectorAll('[aria-label="Історія позичань"] > li')]

          return {
            theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
            pageOverflow: document.documentElement.scrollWidth - viewport,
            tabsOutside: tabs.filter((element) => {
              const box = element.getBoundingClientRect()

              return box.left < 0 || box.right > viewport
            }).length,
            rowsOutside: rows.filter((element) => {
              const box = element.getBoundingClientRect()

              return box.left < 0 || box.right > viewport
            }).length,
            rowsOverflowing: rows.filter((element) => element.scrollWidth > element.clientWidth)
              .length,
            selected: selected.map((element) => element.textContent),
            selectedUnderlines: selected.map(underline),
            otherUnderlines: tabs.filter((element) => !selected.includes(element)).map(underline),
          }
        })

        expect(layout.theme).toBe(theme)
        expect(layout.pageOverflow).toBeLessThanOrEqual(0)
        expect(layout.tabsOutside).toBe(0)
        expect(layout.rowsOutside).toBe(0)
        expect(layout.rowsOverflowing).toBe(0)
        // The active state is both programmatic (`aria-selected`) and visible (the underline).
        expect(layout.selected).toEqual(['Історія'])
        expect(layout.selectedUnderlines).toEqual(['1'])
        expect(new Set(layout.otherUnderlines)).toEqual(new Set(['0']))
      })
    }
  }
})
