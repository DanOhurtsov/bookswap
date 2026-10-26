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
import { ReadingStatusService } from '../../src/reading-status/reading-status.service'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { befriend, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-137: АВТОМАТИЧНИЙ браузерний e2e секції «Що читають мої друзі» на головній. Реальні web (`next dev`)
 * і API (`createTestApp` у цьому процесі) поверх тестової БД, справжній Chromium, синтетичні акаунти й
 * дружби, створені через API. Відповіді продуктового API не підмінено.
 *
 * Підстановки, і лише такі:
 * - обкладинки — вигаданий хост `covers.bs137.test`, запити до якого обслуговує сам браузер (PNG 1×1);
 * - сценарій помилки: перший запит стрічки браузер обриває на рівні мережі (`route.abort`), повтор іде до
 *   справжнього API; сценарій завантаження затримує справжній запит у браузері, не змінюючи відповіді.
 *
 * `BROWSER_SCREENSHOT_DIR` (необовʼязково) — куди покласти знімки для ручного перегляду.
 *
 * Запуск: `pnpm --filter @bookswap/api test:browser`. Без Chromium тест ПАДАЄ (не пропускається).
 */

const THEMES = ['light', 'dark'] as const
const SECTION = 'Що читають мої друзі'
const FEED_PATH = '/api/v1/me/friends/reading'
const COVER_HOST = 'https://covers.bs137.test'
/** A 1×1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
/** One word with no break opportunity: it must wrap inside the card, not widen it. */
const LONG_WORD = 'Найдовшесловобезпробілів'.repeat(5)

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
let librarian: Reader
let sequence = 0
const contexts: BrowserContext[] = []

interface Reader extends Account {
  email: string
}

interface Feed {
  viewer: Reader
  friends: Reader[]
  works: { workId: string; title: string }[]
}

beforeAll(async () => {
  app = await createTestApp()
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
  librarian = await registerReader('bs137-lib', 'Бібліотекарка')
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

/** A work with one edition: a cover from the stub host, or none. No copy — status is about the work. */
async function newWork(title: string, cover: boolean): Promise<{ workId: string; title: string }> {
  sequence += 1

  const work = await request(app.getHttpServer())
    .post(url('/works'))
    .set('Cookie', librarian.cookie)
    .send({ title, origLang: 'uk', authors: [{ name: `Авторка ${String(sequence)}` }] })
    .expect(201)
  const workId = (work.body as { work: { id: string } }).work.id

  await request(app.getHttpServer())
    .post(url(`/works/${workId}/editions`))
    .set('Cookie', librarian.cookie)
    .send({
      publisher: 'Стрічка',
      year: 2024,
      ...(cover ? { coverUrl: `${COVER_HOST}/${workId}.png` } : {}),
    })
    .expect(201)

  return { workId, title }
}

async function setStatus(account: Account, workId: string, status: string): Promise<void> {
  await request(app.getHttpServer())
    .put(url(`/me/reading-statuses/${workId}`))
    .set('Cookie', account.cookie)
    .send({ status })
    .expect(200)
}

/**
 * A viewer with three friends reading five items: one work read by two friends, a long title and a
 * work without a cover among them. Set one after another, so the feed order is the reverse of this.
 */
async function feedOfFive(prefix: string): Promise<Feed> {
  const viewer = await registerReader(`${prefix}-v`, 'Глядачка')
  const friends = [
    await registerReader(`${prefix}-1`, 'Марта'),
    await registerReader(`${prefix}-2`, 'Олесь'),
    await registerReader(`${prefix}-3`, 'Ярина'),
  ]
  const works = [
    await newWork(`Спільна книжка ${String(sequence)}`, true),
    await newWork(`${LONG_WORD} ${String(sequence)}`, true),
    await newWork(`Без обкладинки ${String(sequence)}`, false),
    await newWork(`Четверта ${String(sequence)}`, true),
  ]

  for (const friend of friends) await befriend(app, viewer, friend)

  const [one, two, three] = [friends[0]!, friends[1]!, friends[2]!]
  const [shared, long, bare, fourth] = [works[0]!, works[1]!, works[2]!, works[3]!]

  await setStatus(one, shared.workId, 'READING')
  await setStatus(two, shared.workId, 'READING')
  await setStatus(three, long.workId, 'READING')
  await setStatus(one, bare.workId, 'READING')
  await setStatus(two, fourth.workId, 'READING')
  // Neither of these is «reading now».
  await setStatus(three, fourth.workId, 'READ')
  await setStatus(one, long.workId, 'NOT_READ')

  return { viewer, friends, works }
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
  return section(page).getByRole('listitem')
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

/** Columns, overflow and containment of the cards, as laid out. */
async function geometryOf(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('.friends-reading .result-grid > ul')
    const items = [...document.querySelectorAll('.friends-reading .result-grid > ul > li')]
    const listBox = list?.getBoundingClientRect()
    const firstTop = items[0]?.getBoundingClientRect().top

    return {
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      columns: list === null ? 0 : getComputedStyle(list).gridTemplateColumns.split(' ').length,
      firstRow: items.filter((item) => item.getBoundingClientRect().top === firstTop).length,
      outsideList: items.filter((item) => {
        const box = item.getBoundingClientRect()

        return (
          listBox === undefined || box.left < listBox.left - 0.5 || box.right > listBox.right + 0.5
        )
      }).length,
      // Any descendant wider than its card: a title or a name that did not wrap.
      overflowingCards: items.filter((item) => {
        const box = item.getBoundingClientRect()

        return [...item.querySelectorAll('*')].some(
          (child) => child.getBoundingClientRect().right > box.right + 0.5,
        )
      }).length,
      coverBoxes: items.map((item) => {
        const cover = item.querySelector(
          '[data-slot="book-cover"], [data-slot="book-cover-placeholder"]',
        )
        const box = cover?.getBoundingClientRect()

        return box === undefined
          ? 'none'
          : `${String(Math.round(box.width))}x${String(Math.round(box.height))}`
      }),
    }
  })
}

describe('BS-137: «Що читають мої друзі» на головній (браузер)', () => {
  it('гість: секції немає, і приватний API стрічки не викликає ні браузер, ні сервер', async () => {
    const spy = jest.spyOn(app.get(ReadingStatusService), 'friendsReading')

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

  it('без друзів — пропозиція знайти друзів; посилання з клавіатури веде на пошук людей', async () => {
    const viewer = await registerReader('bs137-alone', 'Самітниця')
    const page = await newPage(390)

    await login(page, viewer.email)
    await section(page).getByText('Додайте друзів, щоб бачити, що вони зараз читають.').waitFor()
    await screenshot(page, 'bs137-no-friends-390-light')

    const link = section(page).getByRole('link', { name: 'Знайти друзів' })

    await link.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/friends/search`)
  })

  it('друзі є, але ніхто не читає — окреме повідомлення; READ → READING додає картку при наступному відкритті', async () => {
    const viewer = await registerReader('bs137-idle-v', 'Глядач')
    const friend = await registerReader('bs137-idle-f', 'Тиха подруга')
    const work = await newWork(`Відкладена ${String(sequence)}`, false)

    await befriend(app, viewer, friend)
    await setStatus(friend, work.workId, 'READ')

    const page = await newPage(1440, 'dark')

    await login(page, viewer.email)
    await section(page).getByText('Зараз ніхто з ваших друзів нічого не читає.').waitFor()
    expect(await section(page).getByRole('link', { name: 'Знайти друзів' }).count()).toBe(0)
    await screenshot(page, 'bs137-nobody-1440-dark')

    await setStatus(friend, work.workId, 'READING')
    await page.reload()
    await section(page).getByRole('link', { name: work.title }).waitFor()
  })

  it('завантаження, помилка з role="alert" і повтор, що приносить справжні картки', async () => {
    const { viewer } = await feedOfFive('bs137-err')
    const page = await newPage()
    const feedRequests = watchFeedRequests(page)
    let release: () => void = () => undefined
    // Until the error is on screen every read fails at the network level. In `next dev` React's
    // StrictMode mounts the section twice and the first read is cancelled, so «the first request» is
    // not a stable target; «every request until the error shows» is.
    let failing = true

    await page.route(`**${FEED_PATH}*`, async (route) => {
      if (failing) {
        await route.abort('failed').catch(() => undefined)

        return
      }

      // The retry goes to the real API, held until the loading state has been seen.
      await new Promise<void>((resolve) => {
        release = resolve
      })
      await route.continue()
    })

    await login(page, viewer.email)

    const alert = section(page).getByRole('alert')

    await alert.waitFor()

    // No retry on its own: nothing more is sent while the error is shown.
    const settled = feedRequests.length

    await page.waitForTimeout(1500)
    expect(feedRequests).toHaveLength(settled)
    failing = false
    expect(await alert.textContent()).toContain('Не вдалося завантажити, що читають друзі.')
    await screenshot(page, 'bs137-error-1440-light')

    const retry = alert.getByRole('button', { name: 'Спробувати ще раз' })

    await retry.focus()
    await page.keyboard.press('Enter')

    await section(page)
      .getByRole('status')
      .filter({ hasText: 'Дивлюся, що читають друзі…' })
      .waitFor()
    expect(await section(page).getAttribute('aria-busy')).toBe('true')
    await screenshot(page, 'bs137-loading-1440-light')
    release()

    await cards(page).first().waitFor()
    expect(await cards(page).count()).toBe(5)
    expect(await section(page).getByRole('alert').count()).toBe(0)
    // The retry is exactly one request.
    expect(feedRequests).toHaveLength(settled + 1)
    expect(new Set(feedRequests)).toEqual(new Set([`GET ${FEED_PATH}`]))
  })

  const WIDTHS: [number, number][] = [
    [375, 1],
    [768, 2],
    [1024, 3],
    [1440, 4],
  ]

  for (const theme of THEMES) {
    it(`сітка 1–4 колонки (375/768/1024/1440), ${theme} тема: картки в межах, довга назва переноситься, однакова обкладинка`, async () => {
      const { viewer, friends, works } = await feedOfFive(`bs137-grid-${theme}`)
      const [shared, long, bare] = [works[0]!, works[1]!, works[2]!]

      for (const [width, columns] of WIDTHS) {
        const page = await newPage(width, theme)

        await login(page, viewer.email)
        await cards(page).first().waitFor()
        await page.waitForLoadState('networkidle')
        await screenshot(page, `bs137-ready-${String(width)}-${theme}`)

        const geometry = await geometryOf(page)

        expect({ width, ...geometry }).toMatchObject({
          width,
          theme,
          columns,
          firstRow: columns,
          outsideList: 0,
          overflowingCards: 0,
        })
        expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
        // Image or placeholder, the box is the same.
        expect(new Set(geometry.coverBoxes)).toEqual(new Set(['128x192']))
      }

      // Content of the cards, at the last width: newest first, one card per friend of the shared work.
      const page = await newPage(1440, theme)

      await login(page, viewer.email)
      await cards(page).first().waitFor()
      expect(await cards(page).count()).toBe(5)
      expect(await section(page).getByRole('link', { name: shared.title }).count()).toBe(2)
      expect(await section(page).getByRole('link', { name: long.title }).count()).toBe(1)

      const bareCard = cards(page).filter({ has: page.getByRole('link', { name: bare.title }) })

      expect(await bareCard.locator('[data-slot="book-cover-placeholder"]').count()).toBe(1)
      expect(await cards(page).locator('img[data-slot="book-cover"]').count()).toBe(4)

      const firstCard = cards(page).first()

      expect(
        await firstCard.getByRole('link', { name: friends[1]!.displayName }).getAttribute('href'),
      ).toBe(`/users/${friends[1]!.id}/library`)
    })
  }

  it('клавіатура: Tab — назва, потім друг; фокус видно; Enter відкриває твір і бібліотеку друга', async () => {
    const { viewer, friends, works } = await feedOfFive('bs137-keys')
    const fourth = works[3]!
    const page = await newPage(1440, 'dark')

    await login(page, viewer.email)
    await cards(page).first().waitFor()

    // The newest item: the fourth work, read by the second friend.
    const firstCard = cards(page).first()
    const title = firstCard.getByRole('link', { name: fourth.title })
    const friend = firstCard.getByRole('link', { name: friends[1]!.displayName })

    // Real Tab presses from the top of the page: a programmatic focus after the mouse click of the login
    // form would not count as keyboard focus, and `:focus-visible` would not apply.
    const titleHref = `/works/${fourth.workId}`

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })

    for (let step = 0; step < 60; step += 1) {
      await page.keyboard.press('Tab')

      if ((await page.evaluate(() => document.activeElement?.getAttribute('href'))) === titleHref)
        break
    }

    const focusOf = () =>
      page.evaluate(() => {
        const active = document.activeElement
        const style = active === null ? null : getComputedStyle(active)

        return {
          href: active?.getAttribute('href') ?? '',
          outline: style === null ? 'none' : `${style.outlineStyle} ${style.outlineWidth}`,
        }
      })

    const onTitle = await focusOf()

    expect(onTitle.href).toBe(titleHref)
    expect(onTitle.outline).not.toMatch(/^none|\s0px$/)
    await screenshot(page, 'bs137-focus-title-1440-dark')

    await page.keyboard.press('Tab')

    const onFriend = await focusOf()

    expect(onFriend.href).toBe(`/users/${friends[1]!.id}/library`)
    // The link found by its accessible name — the initials of the avatar are not part of it.
    expect(await friend.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(onFriend.outline).not.toMatch(/^none|\s0px$/)

    await page.keyboard.press('Tab')
    expect((await focusOf()).href).toBe(`/works/${works[2]!.workId}`)

    await title.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/works/${fourth.workId}`)
    await page.getByRole('heading', { name: fourth.title, level: 1 }).waitFor()

    await page.goBack()
    await page.waitForURL(`${WEB_ORIGIN}/`)
    await friend.focus()
    await page.keyboard.press('Enter')
    await page.waitForURL(`${WEB_ORIGIN}/users/${friends[1]!.id}/library`)
    await page
      .getByRole('heading', { name: `Бібліотека: ${friends[1]!.displayName}`, level: 1 })
      .waitFor()
  })

  it('текст 200 %: без горизонтального скролу, менше колонок, картки й назви в межах', async () => {
    const { viewer } = await feedOfFive('bs137-zoom')
    const page = await newPage(1440, 'light')

    await login(page, viewer.email)
    await cards(page).first().waitFor()
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' })
    await page.waitForLoadState('networkidle')
    await screenshot(page, 'bs137-text200-1440-light')

    const geometry = await geometryOf(page)

    expect(geometry.pageOverflow).toBeLessThanOrEqual(0)
    expect(geometry.columns).toBeLessThan(4)
    expect(geometry.outsideList).toBe(0)
    expect(geometry.overflowingCards).toBe(0)
  })

  it('A → вихід → B у тій самій вкладці: B ніколи не бачить стрічки A', async () => {
    const a = await feedOfFive('bs137-switch')
    const b = await registerReader('bs137-switch-b', 'Інша людина')
    const page = await newPage()

    await page.addInitScript(() => {
      const frames: string[] = []

      ;(window as unknown as { feedFrames: string[] }).feedFrames = frames
      new MutationObserver(() => {
        const block = document.querySelector('.friends-reading')

        if (block !== null) frames.push(block.textContent ?? '')
      }).observe(document, { subtree: true, childList: true, characterData: true })
    })

    await login(page, a.viewer.email)
    await cards(page).first().waitFor()

    await page.getByRole('button', { name: /Відкрити меню профілю/ }).click()
    await page.getByRole('menuitem', { name: 'Вийти' }).click()
    await page.waitForURL(`${WEB_ORIGIN}/login`)

    const before = await page.evaluate(
      () => (window as unknown as { feedFrames: string[] }).feedFrames.length,
    )

    await login(page, b.email)
    await section(page).getByText('Додайте друзів, щоб бачити, що вони зараз читають.').waitFor()

    const framesForB = await page.evaluate(
      (from) => (window as unknown as { feedFrames: string[] }).feedFrames.slice(from),
      before,
    )
    const titlesOfA = a.works.map((work) => work.title)

    expect(framesForB.filter((frame) => titlesOfA.some((title) => frame.includes(title)))).toEqual(
      [],
    )
  })
})
