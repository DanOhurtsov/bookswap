import 'reflect-metadata'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  catalogDiscoveryResponseSchema,
  workHoldersResponseSchema,
  type CatalogDiscoveryResponse,
  type Visibility,
  type WorkHoldersResponse,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { createTestApp } from './auth.helpers'
import { befriend, registerAccount, url, type Account } from './loan.helpers'

interface Bookshelf {
  workId: string
  copyId: string
  editionId: string
  translationId: string | null
}

describe('Aggregated network discovery and "Who has this?" (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService
  let viewer: Account
  let friend: Account
  let friend2: Account
  let stranger: Account
  let counter = 0

  const http = (): App => app.getHttpServer()
  const tag = `нетвор${String(process.pid)}${String(Date.now())}`

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
    ;[viewer, friend, friend2, stranger] = await Promise.all([
      registerAccount(app, 'net-viewer'),
      registerAccount(app, 'net-friend'),
      registerAccount(app, 'net-friend2'),
      registerAccount(app, 'net-stranger'),
    ])
    await befriend(app, viewer, friend)
    await befriend(app, viewer, friend2)
  })

  afterAll(async () => {
    await app.close()
  })

  /** Work + (за бажанням) переклад + видання + примірник, усе через API. */
  async function shelve(
    owner: Account,
    options: {
      title?: string
      visibility?: Visibility
      workId?: string
      translate?: { lang: string; translator: string }
      origLang?: string
    } = {},
  ): Promise<Bookshelf> {
    counter += 1

    let workId = options.workId

    if (workId === undefined) {
      const work = await request(http())
        .post(url('/works'))
        .set('Cookie', owner.cookie)
        .send({
          title: options.title ?? `${tag} книга ${String(counter)}`,
          origLang: options.origLang ?? 'en',
          authors: [{ name: `Автор ${tag}` }],
        })
        .expect(201)

      workId = (work.body as { work: { id: string } }).work.id
    }

    let translationId: string | null = null

    if (options.translate !== undefined) {
      const translation = await request(http())
        .post(url(`/works/${workId}/translations`))
        .set('Cookie', owner.cookie)
        .send({ ...options.translate, sourceLang: options.origLang ?? 'en' })
        .expect(201)

      translationId = (translation.body as { translation: { id: string } }).translation.id
    }

    const edition = await request(http())
      .post(url(`/works/${workId}/editions`))
      .set('Cookie', owner.cookie)
      .send({ translationId, publisher: `Видавництво ${String(counter)}` })
      .expect(201)
    const editionId = (edition.body as { edition: { id: string } }).edition.id
    const copy = await request(http())
      .post(url('/me/library'))
      .set('Cookie', owner.cookie)
      .send({ editionId, visibility: options.visibility ?? 'FRIENDS' })
      .expect(201)

    return {
      workId,
      editionId,
      translationId,
      copyId: (copy.body as { copy: { id: string } }).copy.id,
    }
  }

  async function discover(query: string, who: Account = viewer): Promise<CatalogDiscoveryResponse> {
    const response = await request(http())
      .get(url(`/catalog/discover?${query}`))
      .set('Cookie', who.cookie)
      .expect(200)

    return catalogDiscoveryResponseSchema.parse(response.body)
  }

  async function holders(
    workId: string,
    query = '',
    who: Account = viewer,
  ): Promise<WorkHoldersResponse> {
    const response = await request(http())
      .get(url(`/works/${workId}/holders${query}`))
      .set('Cookie', who.cookie)
      .expect(200)

    return workHoldersResponseSchema.parse(response.body)
  }

  const ids = (response: CatalogDiscoveryResponse): string[] =>
    response.results.map((result) => result.work.id)

  async function lend(owner: Account, borrower: Account, copyId: string, dueAt?: string) {
    const loan = await request(http())
      .post(url('/loans'))
      .set('Cookie', borrower.cookie)
      .send({ copyId })
      .expect(201)
    const loanId = (loan.body as { loan: { id: string } }).loan.id

    await request(http())
      .patch(url(`/loans/${loanId}`))
      .set('Cookie', owner.cookie)
      .send({ action: 'approve', ...(dueAt === undefined ? {} : { dueAt }) })
      .expect(200)
    await request(http())
      .patch(url(`/loans/${loanId}`))
      .set('Cookie', borrower.cookie)
      .send({ action: 'hand_over' })
      .expect(200)

    return loanId
  }

  describe('GET /catalog/discover — Available from friends', () => {
    it('перегляд без тексту: власні й друзів, без незнайомців, у детермінованому порядку', async () => {
      const own = await shelve(viewer, { title: `${tag} aaa своя` })
      const theirs = await shelve(friend, { title: `${tag} bbb друга` })
      const foreign = await shelve(stranger, { title: `${tag} ccc чужа`, visibility: 'PUBLIC' })

      await prisma.user.update({
        where: { id: stranger.id },
        data: { libraryVisibility: 'PUBLIC' },
      })

      const response = await discover(`pageSize=50&q=${encodeURIComponent(tag)}`)
      const found = ids(response)

      expect(found).toContain(own.workId)
      expect(found).toContain(theirs.workId)
      expect(found).not.toContain(foreign.workId)

      const browse = await discover('pageSize=50')

      expect(ids(browse)).toContain(theirs.workId)
      expect(ids(browse)).not.toContain(foreign.workId)

      const again = await discover('pageSize=50')

      expect(ids(again)).toEqual(ids(browse))
      expect(browse.scope).toBe('CIRCLE')

      // Порожній `?q=` — це теж перегляд, а не помилка.
      expect(ids(await discover('pageSize=50&q='))).toEqual(ids(browse))
    })

    it('видимість: PRIVATE примірник і PRIVATE бібліотека друга не показуються', async () => {
      const hidden = await shelve(friend, { title: `${tag} прихована`, visibility: 'PRIVATE' })
      const shown = await shelve(friend, { title: `${tag} видима`, visibility: 'FRIENDS' })
      const inHiddenLibrary = await shelve(friend2, {
        title: `${tag} у закритій`,
        visibility: 'PUBLIC',
      })

      await prisma.user.update({
        where: { id: friend2.id },
        data: { libraryVisibility: 'PRIVATE' },
      })

      try {
        const found = ids(await discover(`q=${encodeURIComponent(tag)}&pageSize=50`))

        expect(found).toContain(shown.workId)
        expect(found).not.toContain(hidden.workId)
        expect(found).not.toContain(inHiddenLibrary.workId)
      } finally {
        await prisma.user.update({
          where: { id: friend2.id },
          data: { libraryVisibility: 'FRIENDS' },
        })
      }
    })

    it('блок у будь-який бік ховає друга; зняття блоку повертає видимість не автоматично', async () => {
      const blockedFriend = await registerAccount(app, 'net-blocked')

      await befriend(app, viewer, blockedFriend)

      const book = await shelve(blockedFriend, { title: `${tag} блоковані` })

      expect(ids(await discover(`q=${encodeURIComponent(tag)}&pageSize=50`))).toContain(book.workId)

      await request(http())
        .post(url(`/friends/${viewer.id}/block`))
        .set('Cookie', blockedFriend.cookie)
        .expect(204)

      expect(ids(await discover(`q=${encodeURIComponent(tag)}&pageSize=50`))).not.toContain(
        book.workId,
      )
      expect(ids(await discover('pageSize=50'))).not.toContain(book.workId)

      const info = await holders(book.workId)

      expect(info.groups).toEqual([])
    })

    it('доступність: за замовчуванням лише AVAILABLE; ANY показує позичене з датою й без позичальника', async () => {
      const borrower = await registerAccount(app, 'net-borrower')

      await befriend(app, friend, borrower)

      const lent = await shelve(friend, { title: `${tag} позичена` })
      const off = await shelve(friend, { title: `${tag} недоступна` })
      const free = await shelve(friend, { title: `${tag} вільна` })

      await lend(friend, borrower, lent.copyId, '2026-12-31')
      await prisma.copy.update({ where: { id: off.copyId }, data: { status: 'UNAVAILABLE' } })

      const query = `q=${encodeURIComponent(tag)}&pageSize=50`
      const available = await discover(query)

      expect(ids(available)).toContain(free.workId)
      expect(ids(available)).not.toContain(lent.workId)
      expect(ids(available)).not.toContain(off.workId)

      const any = await discover(`${query}&availability=ANY`)
      const lentResult = any.results.find((result) => result.work.id === lent.workId)
      const offResult = any.results.find((result) => result.work.id === off.workId)
      const freeResult = any.results.find((result) => result.work.id === free.workId)

      expect(lentResult?.locations[0]).toMatchObject({
        availableCopies: 0,
        copies: [
          {
            id: lent.copyId,
            status: 'LENT_OUT',
            expectedReturnAt: '2026-12-31',
            canRequest: false,
          },
        ],
      })
      expect(offResult?.locations[0]?.copies[0]).toMatchObject({
        status: 'UNAVAILABLE',
        expectedReturnAt: null,
        canRequest: false,
      })
      expect(freeResult?.locations[0]?.copies[0]).toMatchObject({
        status: 'AVAILABLE',
        expectedReturnAt: null,
        canRequest: true,
      })

      // Позичальник не має витікати ні в id, ні в імені.
      const raw = JSON.stringify(any)

      expect(raw).not.toContain(borrower.id)
      expect(raw).not.toContain(borrower.displayName)
    })

    it('фільтри мови й перекладу; ORIGINAL/TRANSLATED; комбінація з текстом', async () => {
      const original = await shelve(friend, { title: `${tag} фільтр`, origLang: 'en' })
      const translated = await shelve(friend2, {
        workId: original.workId,
        origLang: 'en',
        translate: { lang: 'uk', translator: 'Тарас Перекладач' },
      })
      const french = await shelve(friend, {
        title: `${tag} французька`,
        origLang: 'fr',
      })
      const query = `q=${encodeURIComponent(tag)}&pageSize=50`

      const uk = await discover(`${query}&language=uk`)

      expect(ids(uk)).toContain(original.workId)
      expect(ids(uk)).not.toContain(french.workId)
      expect(uk.results.find((r) => r.work.id === original.workId)?.locations).toHaveLength(1)
      expect(uk.results.find((r) => r.work.id === original.workId)?.locations[0]?.owner.id).toBe(
        friend2.id,
      )

      const fr = await discover(`${query}&language=fr`)

      expect(ids(fr)).toContain(french.workId)
      expect(ids(fr)).not.toContain(original.workId)

      const originalOnly = await discover(`${query}&translation=ORIGINAL`)
      const owners = originalOnly.results
        .find((result) => result.work.id === original.workId)
        ?.locations.map((location) => location.owner.id)

      expect(owners).toEqual([friend.id])

      const translatedOnly = await discover(`${query}&translation=TRANSLATED`)

      expect(ids(translatedOnly)).toContain(original.workId)
      expect(ids(translatedOnly)).not.toContain(french.workId)
      expect(translated.translationId).not.toBeNull()

      const narrow = await discover(`${query}&language=uk&translation=ORIGINAL`)

      expect(ids(narrow)).not.toContain(french.workId)
    })

    it('картка показує лише видання з видимими примірниками', async () => {
      const first = await shelve(friend, { title: `${tag} два видання` })
      const second = await shelve(friend2, { workId: first.workId, visibility: 'PRIVATE' })
      const found = (await discover(`q=${encodeURIComponent(`${tag} два видання`)}`)).results[0]

      expect(found?.editions.map((edition) => edition.id)).toEqual([first.editionId])
      expect(JSON.stringify(found)).not.toContain(second.editionId)
    })

    it('canRequest збігається з реальною відповіддю POST /loans', async () => {
      const own = await shelve(viewer, { title: `${tag} моя для запиту` })
      const book = await shelve(friend, { title: `${tag} для запиту` })
      const find = async () =>
        (await discover(`q=${encodeURIComponent(`${tag} для запиту`)}`)).results[0]?.locations[0]
          ?.copies[0]

      expect((await find())?.canRequest).toBe(true)

      const mine = (await discover(`q=${encodeURIComponent(`${tag} моя для запиту`)}`)).results[0]

      expect(mine?.locations[0]).toMatchObject({ relation: 'SELF' })
      expect(mine?.locations[0]?.copies[0]?.canRequest).toBe(false)
      expect(own.copyId).toBeDefined()

      await request(http())
        .post(url('/loans'))
        .set('Cookie', viewer.cookie)
        .send({ copyId: book.copyId })
        .expect(201)

      // Після запиту книжка лишається AVAILABLE, але просити вдруге вже не можна.
      expect((await find())?.status).toBe('AVAILABLE')
      expect((await find())?.canRequest).toBe(false)
      await request(http())
        .post(url('/loans'))
        .set('Cookie', viewer.cookie)
        .send({ copyId: book.copyId })
        .expect(409)
    })

    it('пагінація перегляду: 12 творів → 10 + 2, hasMore правдивий', async () => {
      const owner = await registerAccount(app, 'net-paging')

      await befriend(app, viewer, owner)

      const local = `qwpg${String(Date.now())} paging`

      for (let index = 0; index < 12; index += 1) {
        await shelve(owner, { title: `${local} ${String(100 + index)}` })
      }

      const first = await discover(`q=${encodeURIComponent(local)}&pageSize=10`)
      const second = await discover(`q=${encodeURIComponent(local)}&pageSize=10&page=2`)

      expect(first.results).toHaveLength(10)
      expect(first.hasMore).toBe(true)
      expect(first.total).toBe(12)
      expect(second.results).toHaveLength(2)
      expect(second.hasMore).toBe(false)
      expect(new Set([...ids(first), ...ids(second)]).size).toBe(12)
    })

    it('успадкований режим ALL: без змін для тексту, але без фільтрів і без перегляду', async () => {
      const foreign = await shelve(stranger, {
        title: `${tag} публічна чужа`,
        visibility: 'PUBLIC',
      })

      await prisma.user.update({
        where: { id: stranger.id },
        data: { libraryVisibility: 'PUBLIC' },
      })

      const all = await discover(`q=${encodeURIComponent(`${tag} публічна чужа`)}&scope=ALL`)

      expect(all.results[0]?.locations[0]).toMatchObject({ relation: 'OTHER' })
      expect(all.results[0]?.locations[0]?.copies[0]?.canRequest).toBe(false)
      expect(ids(all)).toContain(foreign.workId)

      const bad = async (query: string) =>
        request(http())
          .get(url(`/catalog/discover?${query}`))
          .set('Cookie', viewer.cookie)
          .expect(400)

      await bad('scope=ALL')
      await bad('scope=ALL&q=книжка&availability=ANY')
      await bad('scope=ALL&q=книжка&language=uk')
      await bad('scope=ALL&q=книжка&translation=ORIGINAL')
    })

    it('валідація: невідомі значення — 400, без сесії — 401', async () => {
      const bad = (query: string) =>
        request(http())
          .get(url(`/catalog/discover?${query}`))
          .set('Cookie', viewer.cookie)
          .expect(400)

      await bad('availability=NOPE')
      await bad('translation=MAYBE')
      await bad('language=zz')
      await bad('language=ukr')
      await bad('q=а')
      await bad('pageSize=7')
      await request(http()).get(url('/catalog/discover')).expect(401)
    })
  })

  describe('GET /works/:id/holders — Who has this?', () => {
    it('групує друзів за перекладом; свої й чужі не показуються; без приватного', async () => {
      const base = await shelve(friend, { title: `${tag} хто має`, origLang: 'en' })
      const ukr = await shelve(friend2, {
        workId: base.workId,
        translate: { lang: 'uk', translator: 'Ірина Перекладачка' },
      })

      await shelve(viewer, { workId: base.workId })
      await shelve(stranger, { workId: base.workId, visibility: 'PUBLIC' })
      await shelve(friend, { workId: base.workId, visibility: 'PRIVATE' })

      const result = await holders(base.workId)

      expect(result.workId).toBe(base.workId)
      expect(result.groups.map((group) => group.translationId)).toEqual([null, ukr.translationId])
      expect(result.groups[0]).toMatchObject({ language: 'en', translator: null })
      expect(result.groups[1]).toMatchObject({ language: 'uk', translator: 'Ірина Перекладачка' })
      expect(result.groups[0]?.owners.map((owner) => owner.owner.id)).toEqual([friend.id])
      expect(result.groups[0]?.owners[0]?.copies).toHaveLength(1)
      expect(result.groups[1]?.owners.map((owner) => owner.owner.id)).toEqual([friend2.id])

      const raw = JSON.stringify(result)

      expect(raw).not.toContain(viewer.id)
      expect(raw).not.toContain(stranger.id)
      expect(raw).not.toMatch(/"note"|"visibility"|"condition"|"email"/)
    })

    it('фільтр за конкретним перекладом і за оригіналом', async () => {
      const base = await shelve(friend, { title: `${tag} фільтр holders`, origLang: 'en' })
      const ukr = await shelve(friend2, {
        workId: base.workId,
        translate: { lang: 'uk', translator: 'Мирослава' },
      })

      const onlyTranslation = await holders(base.workId, `?translationId=${ukr.translationId}`)

      expect(onlyTranslation.groups.map((group) => group.translationId)).toEqual([
        ukr.translationId,
      ])

      const onlyOriginal = await holders(base.workId, '?translationId=original')

      expect(onlyOriginal.groups.map((group) => group.translationId)).toEqual([null])

      const none = await holders(base.workId, '?translationId=не-існує')

      expect(none.groups).toEqual([])
    })

    it('позичений — не доступний, але з очікуваною датою; AVAILABLE ховає його', async () => {
      const borrower = await registerAccount(app, 'net-holder-borrower')

      await befriend(app, friend, borrower)

      const shelf = await shelve(friend, { title: `${tag} позичена в holders` })

      await lend(friend, borrower, shelf.copyId, '2027-01-15')

      const any = await holders(shelf.workId)

      expect(any.groups[0]?.owners[0]).toMatchObject({
        availableCopies: 0,
        copies: [
          {
            id: shelf.copyId,
            status: 'LENT_OUT',
            expectedReturnAt: '2027-01-15',
            canRequest: false,
          },
        ],
      })
      expect(JSON.stringify(any)).not.toContain(borrower.id)
      expect((await holders(shelf.workId, '?availability=AVAILABLE')).groups).toEqual([])
    })

    it('прямий запит із holders без повторного пошуку; після нього canRequest=false', async () => {
      const shelf = await shelve(friend2, { title: `${tag} прямий запит` })
      const before = await holders(shelf.workId)
      const copy = before.groups[0]?.owners[0]?.copies[0]

      expect(copy).toMatchObject({ id: shelf.copyId, canRequest: true })

      await request(http())
        .post(url('/loans'))
        .set('Cookie', viewer.cookie)
        .send({ copyId: copy?.id })
        .expect(201)

      const after = await holders(shelf.workId)

      expect(after.groups[0]?.owners[0]?.copies[0]?.canRequest).toBe(false)
    })

    it('злитий твір → 301 на канонічний із /holders і параметрами; невідомий → 404; без сесії → 401', async () => {
      const kept = await shelve(friend, { title: `${tag} канон` })
      const merged = await shelve(friend, { title: `${tag} дубль` })

      await prisma.work.update({
        where: { id: merged.workId },
        data: { mergedIntoId: kept.workId },
      })
      await prisma.edition.update({
        where: { id: merged.editionId },
        data: { workId: kept.workId },
      })

      const redirect = await request(http())
        .get(url(`/works/${merged.workId}/holders?availability=AVAILABLE`))
        .set('Cookie', viewer.cookie)
        .expect(301)

      expect(redirect.headers.location).toBe(
        url(`/works/${kept.workId}/holders?availability=AVAILABLE`),
      )
      expect((await holders(kept.workId)).groups[0]?.owners[0]?.copies.length).toBe(2)

      await request(http())
        .get(url('/works/немає-такого/holders'))
        .set('Cookie', viewer.cookie)
        .expect(404)
      await request(http())
        .get(url(`/works/${kept.workId}/holders`))
        .expect(401)
      await request(http())
        .get(url(`/works/${kept.workId}/holders?availability=NOPE`))
        .set('Cookie', viewer.cookie)
        .expect(400)
    })
  })
})
