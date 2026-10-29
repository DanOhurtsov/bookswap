import { WEB_ORIGIN, WEB_PORT } from './browser-env'
import 'reflect-metadata'
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from '../auth.helpers'
import { createShelfCopy, url, type Account } from '../loan.helpers'
import { startWeb, stopWeb } from './web-server'

/**
 * BS-146: AUTOMATED browser e2e of coming back after signing in. Not manual QA. Real web (`next dev`)
 * and API (`createTestApp` in this process) over the test database, real Chromium, synthetic accounts
 * only. Nothing is substituted: no API, no router, no data source.
 *
 * Path: a guest opens a signed-in page with a query and a fragment → login → a wrong password → the
 * right one → the same address; the same through register with a taken address first; a signed-in
 * visitor opens the page without passing login; a missing work, a missing copy and a missing route
 * show their own not-found state after login; open-redirect attempts land on the home page.
 *
 * Every direct open is the first navigation of a fresh tab: a full `goto` away from a loaded page
 * crashes the headless Chromium renderer in WSL (see `loans-history-tab.browser-spec.ts`).
 *
 * Run: `pnpm --filter @bookswap/api test:browser`. Without Chromium the test FAILS (it is not skipped).
 */

let app: INestApplication<App>
let browser: Browser
let web: ChildProcess | undefined
const contexts: BrowserContext[] = []

interface Person extends Account {
  email: string
}

let reader: Person
let workId: string

beforeAll(async () => {
  app = await createTestApp()
  web = await startWeb(app, WEB_PORT, WEB_ORIGIN)
  browser = await chromium.launch()
  reader = await register('bs146-reader')
  workId = (await createShelfCopy(app, reader)).workId
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

async function register(prefix: string): Promise<Person> {
  const email = uniqueEmail(prefix)
  const response = await request(app.getHttpServer())
    .post(url('/auth/register'))
    .send({ email, password: VALID_PASSWORD, displayName: `Читачка ${String(process.pid)}` })
    .expect(201)

  return {
    id: (response.body as { user: { id: string } }).user.id,
    cookie: sessionCookie(response.headers),
    displayName: `Читачка ${String(process.pid)}`,
    email,
  }
}

/** A fresh tab; every main-frame address it goes through is recorded, in order. */
async function freshTab(): Promise<{ tab: Page; visited: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })

  contexts.push(context)

  const tab = await context.newPage()
  const visited: string[] = []

  tab.on('framenavigated', (frame) => {
    if (frame === tab.mainFrame()) visited.push(frame.url())
  })

  return { tab, visited }
}

async function signedInTab(person: Person): Promise<{ tab: Page; visited: string[] }> {
  const opened = await freshTab()
  const separator = person.cookie.indexOf('=')

  await opened.tab.context().addCookies([
    {
      name: person.cookie.slice(0, separator),
      value: person.cookie.slice(separator + 1),
      url: WEB_ORIGIN,
    },
  ])

  return opened
}

const loginAddress = (target: string): string =>
  `${WEB_ORIGIN}/login?returnTo=${encodeURIComponent(target)}`

/** The address bar, fragment included — `page.url()` keeps it, the server never saw it. */
const addressOf = (tab: Page): string => tab.url()

/** Waits until the guest guard has sent this tab to login, carrying `target`. */
async function expectSentToLogin(tab: Page, target: string): Promise<void> {
  await tab.waitForURL(loginAddress(target))
  await tab.getByRole('heading', { name: 'Вхід' }).waitFor()
  await tab.waitForLoadState('networkidle')
}

async function submitLogin(tab: Page, email: string, password: string): Promise<void> {
  await tab.getByLabel('Email').fill(email)
  await tab.getByLabel('Пароль').fill(password)
  await tab.getByRole('button', { name: 'Увійти' }).click()
}

/** Entries of this tab's session history; `router.replace` all the way leaves it as it was. */
async function historyLength(tab: Page): Promise<number> {
  return tab.evaluate(() => window.history.length)
}

/**
 * Every request this tab sends for `pathname` from now on. A client navigation fetches the page's
 * RSC payload once; two competing navigations to it (submit's own and the session effect's) fetch it
 * twice — measured on the code before BS-146 — even though only one of them ends up in the address bar.
 */
function requestsFor(tab: Page, pathname: string): string[] {
  const seen: string[] = []

  tab.on('request', (sent) => {
    if (new URL(sent.url()).pathname === pathname) seen.push(sent.url())
  })

  return seen
}

it('guest → login → wrong password → right one → the page, with query and fragment', async () => {
  const target = '/loans?tab=history&bs146=1#history'
  const { tab } = await freshTab()

  await tab.goto(`${WEB_ORIGIN}${target}`)
  await expectSentToLogin(tab, target)
  const entries = await historyLength(tab)

  await submitLogin(tab, reader.email, 'definitely the wrong password')

  await tab.getByText('Невірна пошта або пароль').waitFor()
  expect(addressOf(tab)).toBe(loginAddress(target))
  expect(await tab.getByRole('link', { name: 'Зареєструватися' }).getAttribute('href')).toBe(
    `/register?returnTo=${encodeURIComponent(target)}`,
  )

  const pageRequests = requestsFor(tab, '/loans')

  await submitLogin(tab, reader.email, VALID_PASSWORD)

  await tab.waitForURL(`${WEB_ORIGIN}${target}`)
  await tab
    .getByRole('tablist', { name: 'Вкладки позичань' })
    .getByRole('tab', { name: 'Історія', selected: true })
    .waitFor()
  await tab.waitForLoadState('networkidle')
  expect(addressOf(tab)).toBe(`${WEB_ORIGIN}${target}`)
  // One navigation after submit, not two competing ones.
  expect(pageRequests).toHaveLength(1)
  // Login replaced the page, and the page replaced login: "back" never lands on the login form.
  expect(await historyLength(tab)).toBe(entries)
})

it('guest → login → register → a taken address → a new one → the page', async () => {
  const target = `/works/${workId}?from=bs146#editions`
  const { tab } = await freshTab()

  await tab.goto(`${WEB_ORIGIN}${target}`)
  await expectSentToLogin(tab, target)

  await tab.getByRole('link', { name: 'Зареєструватися' }).click()
  await tab.waitForURL(`${WEB_ORIGIN}/register?returnTo=${encodeURIComponent(target)}`)
  await tab.getByRole('heading', { name: 'Реєстрація' }).waitFor()

  await tab.getByLabel('Імʼя').fill('Нова Читачка')
  await tab.getByLabel('Email').fill(reader.email)
  await tab.getByLabel('Пароль').fill(VALID_PASSWORD)
  await tab.getByRole('button', { name: 'Створити акаунт' }).click()

  await tab.getByText('Акаунт із такою адресою вже існує').waitFor()
  expect(addressOf(tab)).toBe(`${WEB_ORIGIN}/register?returnTo=${encodeURIComponent(target)}`)
  expect(await tab.getByRole('link', { name: 'Увійти' }).last().getAttribute('href')).toBe(
    `/login?returnTo=${encodeURIComponent(target)}`,
  )

  await tab.getByLabel('Email').fill(uniqueEmail('bs146-new'))
  await tab.getByRole('button', { name: 'Створити акаунт' }).click()

  await tab.waitForURL(`${WEB_ORIGIN}${target}`)
  await tab.getByRole('heading', { level: 1 }).filter({ hasText: 'Полиця' }).waitFor()
  expect(addressOf(tab)).toBe(`${WEB_ORIGIN}${target}`)
})

it('a signed-in visitor opens the page directly, never passing login', async () => {
  const target = '/wishlist?bs146=1#top'
  const { tab, visited } = await signedInTab(reader)

  await tab.goto(`${WEB_ORIGIN}${target}`)
  await tab.getByRole('heading', { name: 'Моя бібліотека' }).waitFor()
  await tab.waitForLoadState('networkidle')

  expect(addressOf(tab)).toBe(`${WEB_ORIGIN}${target}`)
  expect(visited.filter((address) => new URL(address).pathname === '/login')).toEqual([])
})

it('a signed-in visitor sent to login with returnTo goes straight on, without the form', async () => {
  const target = '/profile#email'
  const { tab } = await signedInTab(reader)

  await tab.goto(loginAddress(target))

  await tab.waitForURL(`${WEB_ORIGIN}${target}`)
  await tab.getByRole('heading', { name: 'Профіль' }).waitFor()
  expect(await tab.getByLabel('Пароль').count()).toBe(0)
})

describe('a target that is gone shows its own not-found state after login', () => {
  it.each([
    ['a missing work', () => `/works/${randomUUID()}#editions`, 'Твір не знайдено'],
    ['a missing copy', () => `/library/${randomUUID()}?bs146=1`, 'Книжку не знайдено'],
  ])('%s', async (_case, targetOf, message) => {
    const target = targetOf()
    const { tab } = await freshTab()

    await tab.goto(`${WEB_ORIGIN}${target}`)
    await expectSentToLogin(tab, target)
    await submitLogin(tab, reader.email, VALID_PASSWORD)

    await tab.waitForURL(`${WEB_ORIGIN}${target}`)
    await tab.getByText(message).waitFor()
  })

  it('a route that does not exist', async () => {
    const target = '/no-such-page-bs146?x=1#y'
    const { tab } = await freshTab()

    await tab.goto(loginAddress(target))
    await tab.waitForLoadState('networkidle')
    await submitLogin(tab, reader.email, VALID_PASSWORD)

    await tab.waitForURL(`${WEB_ORIGIN}${target}`)
    await tab.getByText('This page could not be found.').waitFor()
  })
})

it.each([
  'https://evil.example/library',
  '//evil.example',
  '/\\evil.example',
  'javascript:alert(document.domain)',
  '/login?returnTo=%2Flibrary',
])('returnTo %j lands on the home page', async (returnTo) => {
  const { tab, visited } = await freshTab()

  await tab.goto(loginAddress(returnTo))
  await tab.waitForLoadState('networkidle')
  expect(await tab.getByRole('link', { name: 'Зареєструватися' }).getAttribute('href')).toBe(
    '/register',
  )
  await submitLogin(tab, reader.email, VALID_PASSWORD)

  await tab.waitForURL(`${WEB_ORIGIN}/`)
  expect(visited.every((address) => new URL(address).origin === WEB_ORIGIN)).toBe(true)
})
