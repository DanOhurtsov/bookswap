import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import type { ExternalSearchResult } from '@bookswap/shared'
import { BOOK_LOOKUP_PROVIDER } from '../../src/catalog/lookup/book-lookup-provider'
import { EXTERNAL_SEARCH_PROVIDERS } from '../../src/catalog/search/external/external-search-provider'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { FakeExternalSearchProvider } from '../lookup/fake-external-search-provider'
import { FakeLookupProvider } from '../lookup/fake-lookup-provider'
import { befriend, registerAccount, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * Vertical search cards (docs/plan/vertical-search-cards.md): the cover on top in one box, then the title,
 * the author and the year, then «+» at the bottom of the card. On `/catalog/new` «+», the title and the
 * cover open the result's dialog and send nothing; `/catalog` keeps its link, editions, owners and the
 * loan request in the same vertical card.
 *
 * Real Chromium, real web (`next dev`) and API (`createTestApp` in this process) over the test database.
 * Stand-ins: the external title search sources and the ISBN lookup are in-process fakes with fixed
 * answers (no call to Open Library or Google Books), and the cover images live on a made-up host whose
 * requests the browser answers itself — one with a real PNG, one with a 404 (a broken cover).
 *
 * Run: `pnpm --filter @bookswap/api test:browser -- search-cards`. Without Chromium the test FAILS.
 */

const WIDTHS = [320, 390, 768, 1024, 1440] as const
const THEMES = ['light', 'dark'] as const

const COVER_HOST = 'https://covers.cards.test'
const GOOD_COVER = `${COVER_HOST}/good.png`
const BROKEN_COVER = `${COVER_HOST}/broken.png`
/** A 1×1 transparent PNG: a square picture in a book-shaped box, so `object-contain` letterboxes it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
/** The one cover box of a vertical card, image and placeholder alike. */
const CARD_COVER_BOX = '128×192'
const LOOKUP_ISBN = '9780306406157'

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let viewer: { email: string; account: Account }
let token: string
const titles = {
  long: '',
  unbroken: '',
  noCover: '',
  work: '',
  externalEdition: '',
  externalWork: '',
  bare: '',
  lookup: '',
}
const openLibrary = new FakeExternalSearchProvider('OPEN_LIBRARY')
const googleBooks = new FakeExternalSearchProvider('GOOGLE_BOOKS')
const lookup = new FakeLookupProvider()
const contexts: BrowserContext[] = []

beforeAll(async () => {
  app = await createTestApp({
    configure: (builder) => {
      builder
        .overrideProvider(EXTERNAL_SEARCH_PROVIDERS)
        .useValue([openLibrary, googleBooks])
        .overrideProvider(BOOK_LOOKUP_PROVIDER)
        .useValue(lookup)
    },
  })
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()

  token = `kartky${Date.now().toString(36)}`
  titles.long = `${token} надзвичайно довга назва книжки, яка мусить переноситися на кілька рядків і ніколи не розширювати картку`
  titles.unbroken = `${token} ${'Ж'.repeat(100)}`
  titles.noCover = `${token} без обкладинки`
  titles.work = `${token} лише твір`
  titles.externalEdition = `${token} зовнішнє видання`
  titles.externalWork = `${token} зовнішній твір`
  titles.bare = `${token} без даних`
  titles.lookup = `Знайдено за ISBN ${token}`

  viewer = await registerViewer()

  const owner = await registerAccount(app, 'br-cards-owner')

  await befriend(app, owner, viewer.account)
  await createBook(owner, {
    title: titles.long,
    author: 'Автор із дуже довгим іменем і ще довшим прізвищем, що мусить переноситися',
    coverUrl: GOOD_COVER,
  })
  await createBook(owner, {
    title: titles.unbroken,
    author: `Автор${'Ж'.repeat(100)}`,
    coverUrl: BROKEN_COVER,
  })
  await createBook(owner, { title: titles.noCover, author: 'Автор' })
  await createWork(owner, { title: titles.work, author: 'Автор твору', firstPubYear: 1840 })

  const editions: ExternalSearchResult[] = [
    {
      id: 'GOOGLE_BOOKS:cards-edition',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: titles.externalEdition,
      authors: ['Зовнішній Автор'],
      publishedYear: 2001,
      firstPublishedYear: 1950,
      publisher: 'Видавець із джерела',
      language: 'en',
      isbn13: '9783161484100',
      externalId: 'cards-edition',
      coverUrl: GOOD_COVER,
    },
    {
      id: 'GOOGLE_BOOKS:cards-bare',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: titles.bare,
      externalId: 'cards-bare',
    },
  ]

  googleBooks.returns(editions)
  openLibrary.returns([
    {
      id: 'OPEN_LIBRARY:/works/OL1W',
      kind: 'WORK',
      sources: ['OPEN_LIBRARY'],
      title: titles.externalWork,
      authors: ['Автор Твору'],
      firstPublishedYear: 1925,
      workExternalId: 'OL1W',
      coverUrl: BROKEN_COVER,
    },
  ])
  lookup.respondWith(LOOKUP_ISBN, {
    title: titles.lookup,
    authors: ['Автор ISBN'],
    publishedYear: 2010,
    publisher: 'Видавець ISBN',
    source: 'GOOGLE_BOOKS',
    externalId: 'cards-isbn',
    coverUrl: GOOD_COVER,
  })
}, 300_000)

afterAll(async () => {
  for (const context of contexts) await context.close().catch(() => undefined)

  await browser?.close().catch(() => undefined)
  await stopWeb(web)
  await app?.close()
})

async function registerViewer(): Promise<{ email: string; account: Account }> {
  const email = uniqueEmail('br-cards')
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: 'Перевірка карток' })
    .expect(201)

  return {
    email,
    account: {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
      displayName: 'Перевірка карток',
    },
  }
}

async function createWork(
  owner: Account,
  work: { title: string; author: string; firstPubYear?: number },
): Promise<string> {
  const response = await request(app.getHttpServer())
    .post(url('/works'))
    .set('Cookie', owner.cookie)
    .send({
      title: work.title,
      origLang: 'uk',
      authors: [{ name: work.author }],
      ...(work.firstPubYear === undefined ? {} : { firstPubYear: work.firstPubYear }),
    })
    .expect(201)

  return (response.body as { work: { id: string } }).work.id
}

/** One work with one edition and a copy of the owner's, visible to friends. */
async function createBook(
  owner: Account,
  book: { title: string; author: string; coverUrl?: string },
): Promise<void> {
  const workId = await createWork(owner, book)
  const created = await request(app.getHttpServer())
    .post(url(`/works/${workId}/editions`))
    .set('Cookie', owner.cookie)
    .send({
      publisher: 'Видавництво',
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

/** Requests that would add a book: none may leave before «Додати до бібліотеки» in the dialog. */
function trackAdds(page: Page): string[] {
  const sent: string[] = []

  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname.endsWith('/me/library/quick-add')) {
      sent.push(outgoing.method())
    }
  })

  return sent
}

interface Cards {
  theme: string
  viewport: number
  pageOverflow: number
  cards: number
  /** Cards, or anything inside one, sticking out of the card or the list. */
  overflowing: string[]
  /** Every cover box (image or placeholder) in the grid, as `width×height`. */
  coverBoxes: string[]
  placeholders: number
  loadedImages: number
  /** Cards whose cover is not centered, or not above the text, or whose text is not below it. */
  misplaced: string[]
  /** Rows (by top edge) whose «+» buttons are not at the same place. */
  misalignedRows: string[]
  /** «+» buttons something else covers at their center. */
  coveredPlus: string[]
  /** Covers whose center does not hit the card's title button (the stretched target). */
  deadCovers: string[]
}

/**
 * The geometry of every card in the grid. `withPlus` — `/catalog/new`, where each card ends in «+» and
 * its title is stretched over the card; `/catalog` has neither.
 */
function cards(page: Page, withPlus: boolean): Promise<Cards> {
  return page.evaluate((plusExpected): Cards => {
    const list = document.querySelector('.result-grid > ul')

    if (list === null) throw new Error('No result grid')

    const listRect = list.getBoundingClientRect()
    const items = [...list.querySelectorAll<HTMLElement>(":scope > li[data-slot='result-card']")]
    const overflowing: string[] = []
    const misplaced: string[] = []
    const coveredPlus: string[] = []
    const deadCovers: string[] = []
    const rows = new Map<number, { bottom: number; right: number }[]>()
    const name = (card: HTMLElement): string => (card.textContent ?? '').slice(0, 40)

    for (const card of items) {
      card.scrollIntoView({ block: 'center', behavior: 'instant' })

      const rect = card.getBoundingClientRect()

      if (rect.left < listRect.left - 0.5 || rect.right > listRect.right + 0.5) {
        overflowing.push(`card: ${name(card)}`)
      }
      if (card.scrollWidth > card.clientWidth) overflowing.push(`scroll: ${name(card)}`)

      for (const inner of card.querySelectorAll('*')) {
        const box = inner.getBoundingClientRect()

        if (box.width > 0 && (box.left < rect.left - 0.5 || box.right > rect.right + 0.5)) {
          overflowing.push(`inside: ${(inner.textContent ?? inner.tagName).slice(0, 40)}`)
        }
      }

      const [coverSlot, text, footer] = [...card.children]
      const cover = coverSlot?.querySelector<HTMLElement>(
        "[data-slot='book-cover'], [data-slot='book-cover-placeholder']",
      )

      if (cover === null || cover === undefined || text === undefined) {
        misplaced.push(`structure: ${name(card)}`)
        continue
      }

      const coverRect = cover.getBoundingClientRect()
      const textRect = text.getBoundingClientRect()
      const lines = [...text.children].map((line) => line.getBoundingClientRect())

      if (Math.abs(coverRect.left + coverRect.width / 2 - (rect.left + rect.width / 2)) > 1) {
        misplaced.push(`not centered: ${name(card)}`)
      }
      if (coverRect.bottom > textRect.top + 0.5) misplaced.push(`cover not on top: ${name(card)}`)
      // Title, author and year are separate lines, top to bottom.
      for (let index = 1; index < lines.length; index += 1) {
        const previous = lines[index - 1]
        const current = lines[index]

        if (
          previous !== undefined &&
          current !== undefined &&
          current.top < previous.bottom - 0.5
        ) {
          misplaced.push(`lines overlap: ${name(card)}`)
        }
      }

      if (!plusExpected) continue

      const plus = footer?.querySelector<HTMLElement>('button[aria-label^="Додати «"]')

      if (plus === null || plus === undefined) {
        misplaced.push(`no plus: ${name(card)}`)
        continue
      }

      const plusRect = plus.getBoundingClientRect()

      if (plusRect.top < textRect.bottom - 0.5) misplaced.push(`plus above text: ${name(card)}`)

      const top = Math.round(rect.top + window.scrollY)
      const row = rows.get(top) ?? []

      row.push({ bottom: rect.bottom - plusRect.bottom, right: rect.right - plusRect.right })
      rows.set(top, row)

      const hit = document.elementFromPoint(
        plusRect.left + plusRect.width / 2,
        plusRect.top + plusRect.height / 2,
      )

      if (hit === null || !plus.contains(hit)) coveredPlus.push(name(card))

      const title = text.querySelector('button')
      const coverHit = document.elementFromPoint(
        coverRect.left + coverRect.width / 2,
        coverRect.top + coverRect.height / 2,
      )

      if (title === null || coverHit !== title) deadCovers.push(name(card))
    }

    const misalignedRows = [...rows.entries()]
      .filter(([, row]) =>
        row.some(
          (one) =>
            Math.abs(one.bottom - (row[0]?.bottom ?? 0)) > 0.5 ||
            Math.abs(one.right - (row[0]?.right ?? 0)) > 0.5,
        ),
      )
      .map(([top]) => String(top))
    const covers = [
      ...list.querySelectorAll<HTMLElement>(
        "[data-slot='book-cover'], [data-slot='book-cover-placeholder']",
      ),
    ]

    window.scrollTo({ top: 0, behavior: 'instant' })

    return {
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      viewport: document.documentElement.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cards: items.length,
      overflowing,
      coverBoxes: covers.map((cover) => {
        const box = cover.getBoundingClientRect()

        return `${String(Math.round(box.width))}×${String(Math.round(box.height))}`
      }),
      placeholders: list.querySelectorAll("[data-slot='book-cover-placeholder']").length,
      loadedImages: [
        ...list.querySelectorAll<HTMLImageElement>("img[data-slot='book-cover']"),
      ].filter((image) => image.complete && image.naturalWidth > 0).length,
      misplaced,
      misalignedRows,
      coveredPlus,
      deadCovers,
    }
  }, withPlus)
}

async function showCards(page: Page, path: string, count: number): Promise<void> {
  await page.goto(`${WEB_ORIGIN}${path}`)
  await page
    .locator(".result-grid li[data-slot='result-card']")
    .nth(count - 1)
    .waitFor()
  // The broken covers have answered (404) and been replaced by the placeholder.
  await page.waitForLoadState('networkidle')
}

function card(page: Page, title: string) {
  return page.locator("li[data-slot='result-card']").filter({ hasText: title })
}

/** Local: 3 editions + 1 work; external: 2 editions + 1 work. */
const ADD_CARDS = 7
/** The 3 works that have a copy. */
const CATALOG_CARDS = 3

describe('vertical search cards', () => {
  for (const theme of THEMES) {
    it(`/catalog/new and /catalog at every width: cover on top, one box, separate lines, «+» aligned, no overflow, ${theme} theme`, async () => {
      const page = await signedIn(theme)

      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })

        for (const [route, count, withPlus] of [
          ['/catalog/new', ADD_CARDS, true],
          ['/catalog', CATALOG_CARDS, false],
        ] as const) {
          await showCards(page, `${route}?q=${token}`, count)

          const found = await cards(page, withPlus)

          expect(found.theme).toBe(theme)
          expect(found.viewport).toBe(width)
          expect(found.pageOverflow).toBe(0)
          expect(found.cards).toBe(count)
          expect(found.overflowing).toEqual([])
          expect(found.misplaced).toEqual([])
          expect(found.misalignedRows).toEqual([])
          expect(found.coveredPlus).toEqual([])
          expect(found.deadCovers).toEqual([])
          // The picture, the missing cover and the broken one: one box.
          expect(new Set(found.coverBoxes)).toEqual(new Set([CARD_COVER_BOX]))
          if (withPlus) {
            // Good: the long local title and the external edition. Broken: the unbroken title and the
            // external work. Missing: the rest.
            expect(found.loadedImages).toBe(2)
            expect(found.placeholders).toBe(ADD_CARDS - 2)
          }

          await screenshot(
            page,
            `${route === '/catalog' ? 'catalog' : 'catalog-new'}-${String(width)}-${theme}`,
          )
        }
      }
    })
  }

  it('each card shows the title, the author and the year — for a work the first publication, captioned', async () => {
    const page = await signedIn('light')

    await showCards(page, `/catalog/new?q=${token}`, ADD_CARDS)

    for (const [title, lines, absent] of [
      [titles.noCover, ['Автор', '2024'], ['Видавництво']],
      [titles.work, ['Автор твору', 'Уперше видано 1840'], []],
      [
        titles.externalEdition,
        ['Зовнішній Автор', '2001'],
        ['1950', 'Видавець із джерела', 'англійська', '9783161484100'],
      ],
      [titles.externalWork, ['Автор Твору', 'Уперше видано 1925'], []],
    ] as const) {
      const one = card(page, title)

      for (const line of lines) await one.getByText(line, { exact: true }).waitFor()
      for (const fact of absent) {
        await expect(one.getByText(fact).count()).resolves.toBe(0)
      }
    }

    // Nothing made up for a record that knows nothing: the title and «+» only.
    await expect(card(page, titles.bare).innerText()).resolves.toBe(titles.bare)
  })

  for (const [kind, title, path] of [
    ['our edition', () => titles.noCover, () => `/catalog/new?q=${token}`],
    ['our work', () => titles.work, () => `/catalog/new?q=${token}`],
    ['an external edition', () => titles.externalEdition, () => `/catalog/new?q=${token}`],
    ['an external work', () => titles.externalWork, () => `/catalog/new?q=${token}`],
    ['the ISBN lookup', () => titles.lookup, () => `/catalog/new?q=${LOOKUP_ISBN}`],
  ] as const) {
    it(`${kind}: «+», the title and the cover open this book's dialog and add nothing; focus goes back to the opener`, async () => {
      const page = await signedIn('dark', 390)
      const adds = trackAdds(page)

      await showCards(page, path(), 1)

      const one = card(page, title())
      const plus = one.getByRole('button', { name: `Додати «${title()}»` })
      const heading = one.getByRole('button', { name: title(), exact: true })
      const dialog = page.getByRole('dialog')

      await expect(plus.getAttribute('aria-haspopup')).resolves.toBe('dialog')

      for (const [opener, open, close] of [
        ['plus', () => plus.click(), () => page.keyboard.press('Escape')],
        [
          'title',
          () => heading.click(),
          () => dialog.getByRole('button', { name: 'Закрити' }).click(),
        ],
        [
          'cover',
          // By the mouse at the cover's center: what is hit there is the browser's business, not a
          // locator's (Playwright would refuse a click that the stretched title intercepts).
          async () => {
            const box = await one
              .locator("[data-slot='book-cover'], [data-slot='book-cover-placeholder']")
              .boundingBox()

            if (box === null) throw new Error('Обкладинки не видно')

            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
          },
          () => page.keyboard.press('Escape'),
        ],
      ] as const) {
        await open()
        await dialog.waitFor()

        await expect(page.getByRole('dialog').count()).resolves.toBe(1)
        await expect(dialog.getByRole('heading').innerText()).resolves.toBe(title())

        if (opener === 'plus') await screenshot(page, `dialog-${kind.replaceAll(' ', '-')}`)

        await close()
        await dialog.waitFor({ state: 'detached' })

        // The cover is not a control: a click on it is the title's stretched target.
        const focused = opener === 'plus' ? plus : heading

        await expect(
          focused.evaluate((element) => element === document.activeElement),
        ).resolves.toBe(true)
      }

      expect(adds).toEqual([])
    })
  }

  for (const theme of THEMES) {
    it(`keyboard: Tab from the title reaches «+» with a visible ring; Enter and Space open the dialog, ${theme} theme`, async () => {
      const page = await signedIn(theme, 1024)
      const adds = trackAdds(page)

      await showCards(page, `/catalog/new?q=${token}`, ADD_CARDS)

      const one = card(page, titles.noCover)
      const plus = one.getByRole('button', { name: `Додати «${titles.noCover}»` })

      await one.getByRole('button', { name: titles.noCover, exact: true }).focus()
      await page.keyboard.press('Tab')

      await expect(plus.evaluate((element) => element === document.activeElement)).resolves.toBe(
        true,
      )
      await expect(
        plus.evaluate((element) => {
          const style = getComputedStyle(element)

          return style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
        }),
      ).resolves.toBe(true)
      await screenshot(page, `focus-plus-1024-${theme}`)

      for (const key of ['Enter', 'Space']) {
        await page.keyboard.press(key)
        await page.getByRole('dialog').waitFor()
        await expect(page.getByRole('dialog').count()).resolves.toBe(1)
        await page.keyboard.press('Escape')
        await page.getByRole('dialog').waitFor({ state: 'detached' })
        await expect(plus.evaluate((element) => element === document.activeElement)).resolves.toBe(
          true,
        )
      }

      expect(adds).toEqual([])
    })
  }

  it('the add goes only from the dialog; the card keeps its short state beside «+»', async () => {
    const page = await signedIn('light', 768)
    const adds = trackAdds(page)

    await showCards(page, `/catalog/new?q=${token}`, ADD_CARDS)

    const one = card(page, titles.noCover)

    await one.getByRole('button', { name: `Додати «${titles.noCover}»` }).click()
    expect(adds).toEqual([])

    const dialog = page.getByRole('dialog')

    await dialog.getByRole('button', { name: 'Додати до бібліотеки' }).click()
    await dialog.getByRole('button', { name: '✓ У моїй бібліотеці' }).waitFor()
    expect(adds).toEqual(['POST'])

    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await one.getByText('✓ У моїй бібліотеці').waitFor()
    await screenshot(page, 'catalog-new-added-768-light')

    // Reopened by «+»: the next copy is a separate, explicit action.
    await one.getByRole('button', { name: `Додати «${titles.noCover}»` }).click()
    await dialog.getByRole('button', { name: 'Додати ще один примірник' }).waitFor()
    expect(adds).toEqual(['POST'])
  })

  it('/catalog keeps the link to the work, the edition, the owner and the loan request', async () => {
    const page = await signedIn('dark', 1440)

    await showCards(page, `/catalog?q=${token}`, CATALOG_CARDS)

    const one = card(page, titles.noCover)

    await expect(
      one.getByRole('link', { name: titles.noCover, exact: true }).getAttribute('href'),
    ).resolves.toMatch(/^\/works\//)
    // The edition line: publisher · year · language.
    await one.getByText(/Видавництво · 2024/).waitFor()
    await one.getByRole('link', { name: /^У br-cards-owner/ }).waitFor()
    await one.getByRole('button', { name: 'Попросити' }).click()
    // The request form opens inside the same card, still within it.
    await one.getByRole('button', { name: 'Скасувати' }).waitFor()

    const found = await cards(page, false)

    expect(found.overflowing).toEqual([])
    expect(found.pageOverflow).toBe(0)
    await screenshot(page, 'catalog-request-1440-dark')
  })
})

/** Screenshots for a person to look at, only when `SEARCH_CARDS_SCREENSHOTS` names a directory. */
async function screenshot(page: Page, name: string): Promise<void> {
  const directory = process.env.SEARCH_CARDS_SCREENSHOTS

  if (directory !== undefined)
    await page.screenshot({ path: `${directory}/${name}.png`, fullPage: true })
}
