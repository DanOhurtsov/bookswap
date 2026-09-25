import 'reflect-metadata'
import { Logger, type INestApplication } from '@nestjs/common'
import request from 'supertest'
import type { App } from 'supertest/types'
import {
  API_PREFIX,
  acceptInvitationResponseSchema,
  apiErrorSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
  resolveInvitationResponseSchema,
} from '@bookswap/shared'
import { PrismaService } from '../src/prisma/prisma.service'
import { hashToken } from '../src/auth/tokens'
import { VALID_PASSWORD, createTestApp, sessionCookie, uniqueEmail } from './auth.helpers'

type Account = { id: string; cookie: string }

describe('Invitations (e2e)', () => {
  let app: INestApplication<App>
  let prisma: PrismaService

  const url = (path: string): string => `${API_PREFIX}${path}`
  const http = (): App => app.getHttpServer()

  beforeAll(async () => {
    app = await createTestApp()
    prisma = app.get(PrismaService)
  })

  afterAll(async () => {
    await app.close()
  })

  async function register(name: string): Promise<Account> {
    const response = await request(http())
      .post(url('/auth/register'))
      .send({ email: uniqueEmail('invite'), password: VALID_PASSWORD, displayName: name })
      .expect(201)

    return {
      id: (response.body as { user: { id: string } }).user.id,
      cookie: sessionCookie(response.headers),
    }
  }

  async function createLink(inviter: Account): Promise<{ id: string; token: string }> {
    const response = await request(http())
      .post(url('/invitations'))
      .set('Cookie', inviter.cookie)
      .send({ kind: 'LINK' })
      .expect(201)
    const parsed = createInvitationResponseSchema.parse(response.body)

    if (parsed.token === undefined) throw new Error('Посилання має повернути токен')

    return { id: parsed.invitation.id, token: parsed.token }
  }

  const accept = (who: Account, token: string) =>
    request(http()).post(url('/invitations/accept')).set('Cookie', who.cookie).send({ token })

  const resolve = (who: Account, token: string) =>
    request(http()).post(url('/invitations/resolve')).set('Cookie', who.cookie).send({ token })

  const pairOf = (one: string, other: string) =>
    prisma.friendship.findFirst({
      where: {
        OR: [
          { userAId: one, userBId: other },
          { userAId: other, userBId: one },
        ],
      },
    })

  function errorCode(body: unknown): string {
    return apiErrorSchema.parse(body).code
  }

  describe('створення й перегляд', () => {
    it('повертає токен один раз, у БД лежить лише геш, у списку токена немає', async () => {
      const inviter = await register('Марта')
      const { id, token } = await createLink(inviter)

      const row = await prisma.invitation.findUniqueOrThrow({ where: { id } })

      expect(row.tokenHash).toBe(hashToken(token))
      expect(JSON.stringify(row)).not.toContain(token)
      expect(row.maxUses).toBe(10)
      expect(row.kind).toBe('LINK')
      expect(row.recipientEmailHash).toBeNull()

      const ttl = row.expiresAt.getTime() - Date.now()

      expect(ttl).toBeGreaterThan(14 * 24 * 60 * 60 * 1000 - 10_000)
      expect(ttl).toBeLessThanOrEqual(14 * 24 * 60 * 60 * 1000)

      const list = await request(http())
        .get(url('/invitations'))
        .set('Cookie', inviter.cookie)
        .expect(200)

      expect(JSON.stringify(list.body)).not.toContain(token)
      expect(invitationListResponseSchema.parse(list.body).invitations).toEqual([
        expect.objectContaining({ id, status: 'ACTIVE', acceptedCount: 0, maxUses: 10 }),
      ])
    })

    it('список бачить лише власні запрошення', async () => {
      const one = await register('Перша')
      const two = await register('Друга')

      await createLink(one)

      const list = await request(http()).get(url('/invitations')).set('Cookie', two.cookie)

      expect(invitationListResponseSchema.parse(list.body).invitations).toEqual([])
    })

    it('без сесії — 401 на всіх маршрутах', async () => {
      await request(http()).post(url('/invitations')).send({ kind: 'LINK' }).expect(401)
      await request(http()).get(url('/invitations')).expect(401)
      await request(http()).post(url('/invitations/resolve')).send({ token: 'x' }).expect(401)
      await request(http()).post(url('/invitations/accept')).send({ token: 'x' }).expect(401)
      await request(http()).delete(url('/invitations/any')).expect(401)
    })

    it('валідація: невідомий kind, порожній/задовгий токен, зайві поля — 400', async () => {
      const user = await register('Валідатор')
      const post = (path: string, body: object) =>
        request(http()).post(url(path)).set('Cookie', user.cookie).send(body)

      await post('/invitations', { kind: 'SMS' }).expect(400)
      await post('/invitations', {}).expect(400)
      await post('/invitations', { kind: 'EMAIL' }).expect(400)
      await post('/invitations', { kind: 'EMAIL', email: 'not-an-email' }).expect(400)
      await post('/invitations/accept', { token: '' }).expect(400)
      await post('/invitations/accept', { token: 'a'.repeat(129) }).expect(400)
      await post('/invitations/accept', { token: 123 }).expect(400)
      await post('/invitations/accept', { token: 'ok', extra: true }).expect(400)
      await post('/invitations/resolve', {}).expect(400)
    })
  })

  describe('invite → accept → видима бібліотека', () => {
    it('resolve нічого не створює; дружба виникає лише після явного accept', async () => {
      const inviter = await register('Запрошувачка')
      const invitee = await register('Запрошений')
      const { token } = await createLink(inviter)

      const resolved = resolveInvitationResponseSchema.parse(
        (await resolve(invitee, token).expect(200)).body,
      )

      expect(resolved.state).toBe('ACTIVE')
      expect(resolved.inviter).toEqual({
        id: inviter.id,
        displayName: 'Запрошувачка',
        avatarUrl: null,
      })
      expect(resolved.relation).toBe('NONE')
      expect(await pairOf(inviter.id, invitee.id)).toBeNull()

      const accepted = acceptInvitationResponseSchema.parse(
        (await accept(invitee, token).expect(200)).body,
      )

      expect(accepted.relation).toBe('FRIENDS')

      const friendship = await pairOf(inviter.id, invitee.id)

      expect(friendship).toMatchObject({ status: 'ACCEPTED', requestedById: inviter.id })
      expect(friendship?.respondedAt).not.toBeNull()

      await request(http())
        .get(url(`/users/${inviter.id}/library`))
        .set('Cookie', invitee.cookie)
        .expect(200)
    })

    it('resolve відповідає без email і службових полів запрошувача', async () => {
      const inviter = await register('Без пошти')
      const invitee = await register('Гість')
      const { token } = await createLink(inviter)
      const body = (await resolve(invitee, token).expect(200)).body as { inviter: object }

      expect(Object.keys(body.inviter).sort()).toEqual(['avatarUrl', 'displayName', 'id'])
    })

    it('запрошувач отримує сповіщення про згоду, обидві сторони — подію FRIEND_ACCEPTED', async () => {
      const inviter = await register('Сповіщувана')
      const invitee = await register('Сповіщувач')
      const { token } = await createLink(inviter)

      await accept(invitee, token).expect(200)

      const notification = await prisma.notification.findFirst({
        where: { userId: inviter.id, type: 'FRIEND_ACCEPTED' },
      })

      expect(notification).not.toBeNull()
      expect(await prisma.notification.count({ where: { userId: invitee.id } })).toBe(0)

      const events = await prisma.productEvent.count({
        where: { type: 'FRIEND_ACCEPTED', subjectUserId: { in: [inviter.id, invitee.id] } },
      })

      expect(events).toBe(2)
    })

    it('повторне прийняття тим самим користувачем ідемпотентне й не витрачає використання', async () => {
      const inviter = await register('Ідемпотентна')
      const invitee = await register('Повторний')
      const { id, token } = await createLink(inviter)

      await accept(invitee, token).expect(200)

      const again = acceptInvitationResponseSchema.parse(
        (await accept(invitee, token).expect(200)).body,
      )

      expect(again.relation).toBe('FRIENDS')
      expect(await prisma.invitationAcceptance.count({ where: { invitationId: id } })).toBe(1)

      const resolved = resolveInvitationResponseSchema.parse(
        (await resolve(invitee, token).expect(200)).body,
      )

      expect(resolved.state).toBe('ALREADY_ACCEPTED')
    })

    it('після видалення дружби той самий токен не відновлює її мовчки', async () => {
      const inviter = await register('Розірвала')
      const invitee = await register('Розірваний')
      const { token } = await createLink(inviter)

      await accept(invitee, token).expect(200)
      await request(http())
        .delete(url(`/friends/${inviter.id}`))
        .set('Cookie', invitee.cookie)
        .expect(204)

      const again = acceptInvitationResponseSchema.parse(
        (await accept(invitee, token).expect(200)).body,
      )

      expect(again.relation).toBe('NONE')
      expect(await pairOf(inviter.id, invitee.id)).toBeNull()
    })

    it('уже друзі: прийняття не витрачає використання й не пише acceptance', async () => {
      const inviter = await register('Давня')
      const invitee = await register('Давній')
      const { id, token } = await createLink(inviter)

      await request(http())
        .post(url('/friends/requests'))
        .set('Cookie', inviter.cookie)
        .send({ userId: invitee.id })
        .expect(201)
      await request(http())
        .post(url('/friends/requests'))
        .set('Cookie', invitee.cookie)
        .send({ userId: inviter.id })
        .expect(201)

      const accepted = acceptInvitationResponseSchema.parse(
        (await accept(invitee, token).expect(200)).body,
      )

      expect(accepted.relation).toBe('FRIENDS')
      expect(await prisma.invitationAcceptance.count({ where: { invitationId: id } })).toBe(0)
    })

    it('висячий запит у бік запрошувача стає дружбою після accept', async () => {
      const inviter = await register('Отримувачка')
      const invitee = await register('Ініціатор')
      const { token } = await createLink(inviter)

      await request(http())
        .post(url('/friends/requests'))
        .set('Cookie', invitee.cookie)
        .send({ userId: inviter.id })
        .expect(201)

      await accept(invitee, token).expect(200)

      expect(await pairOf(inviter.id, invitee.id)).toMatchObject({ status: 'ACCEPTED' })
    })

    it('власне запрошення: SELF у resolve і 400 INVITE_SELF в accept', async () => {
      const inviter = await register('Сама собі')
      const { token } = await createLink(inviter)

      expect(
        resolveInvitationResponseSchema.parse((await resolve(inviter, token).expect(200)).body)
          .state,
      ).toBe('SELF')

      const response = await accept(inviter, token).expect(400)

      expect(errorCode(response.body)).toBe('INVITE_SELF')
    })

    it('невідомий токен — 404 INVITE_INVALID і в resolve, і в accept', async () => {
      const user = await register('Випадковий')

      expect(errorCode((await resolve(user, 'nope').expect(404)).body)).toBe('INVITE_INVALID')
      expect(errorCode((await accept(user, 'nope').expect(404)).body)).toBe('INVITE_INVALID')
    })
  })

  describe('блокування', () => {
    it('запрошений заблокував запрошувача — INVITE_INVALID, блок і відсутність дружби лишаються', async () => {
      const inviter = await register('Заблокована')
      const invitee = await register('Блокувальник')
      const { token } = await createLink(inviter)

      await request(http())
        .post(url(`/friends/${inviter.id}/block`))
        .set('Cookie', invitee.cookie)
        .expect(204)

      expect(errorCode((await resolve(invitee, token).expect(404)).body)).toBe('INVITE_INVALID')
      expect(errorCode((await accept(invitee, token).expect(404)).body)).toBe('INVITE_INVALID')
      expect(await pairOf(inviter.id, invitee.id)).toMatchObject({
        status: 'BLOCKED',
        blockedById: invitee.id,
      })
    })

    it('запрошувач заблокував запрошеного — так само, без розкриття причини', async () => {
      const inviter = await register('Блокувальниця')
      const invitee = await register('Заблокований')
      const { id, token } = await createLink(inviter)

      await request(http())
        .post(url(`/friends/${invitee.id}/block`))
        .set('Cookie', inviter.cookie)
        .expect(204)

      const response = await accept(invitee, token).expect(404)

      expect(errorCode(response.body)).toBe('INVITE_INVALID')
      expect(await prisma.invitationAcceptance.count({ where: { invitationId: id } })).toBe(0)
      expect(await pairOf(inviter.id, invitee.id)).toMatchObject({ status: 'BLOCKED' })
    })
  })

  describe('строк дії і revoke', () => {
    it('прострочене: 410 INVITE_EXPIRED, дружби немає, resolve каже EXPIRED', async () => {
      const inviter = await register('Прострочена')
      const invitee = await register('Спізнився')
      const { id, token } = await createLink(inviter)

      await prisma.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })

      const response = await accept(invitee, token).expect(410)

      expect(errorCode(response.body)).toBe('INVITE_EXPIRED')
      expect(await pairOf(inviter.id, invitee.id)).toBeNull()
      expect(
        resolveInvitationResponseSchema.parse((await resolve(invitee, token).expect(200)).body)
          .state,
      ).toBe('EXPIRED')

      const list = await request(http()).get(url('/invitations')).set('Cookie', inviter.cookie)

      expect(invitationListResponseSchema.parse(list.body).invitations[0]?.status).toBe('EXPIRED')
    })

    it('за секунду до строку ще працює', async () => {
      const inviter = await register('Останнього дня')
      const invitee = await register('Встиг')
      const { id, token } = await createLink(inviter)

      await prisma.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() + 60_000) },
      })

      await accept(invitee, token).expect(200)
    })

    it('revoke: нові прийняття 410 INVITE_REVOKED, вже створена дружба лишається', async () => {
      const inviter = await register('Відкликає')
      const early = await register('Встиг раніше')
      const late = await register('Спізнився пізніше')
      const { id, token } = await createLink(inviter)

      await accept(early, token).expect(200)
      await request(http())
        .delete(url(`/invitations/${id}`))
        .set('Cookie', inviter.cookie)
        .expect(204)

      expect(errorCode((await accept(late, token).expect(410)).body)).toBe('INVITE_REVOKED')
      expect(await pairOf(inviter.id, late.id)).toBeNull()
      expect(await pairOf(inviter.id, early.id)).toMatchObject({ status: 'ACCEPTED' })

      // Ті, хто вже прийняв, мають ідемпотентну відповідь навіть після revoke.
      await accept(early, token).expect(200)
    })

    it('revoke повторюваний (204), чужий і неіснуючий id — 404', async () => {
      const inviter = await register('Власниця')
      const stranger = await register('Чужий')
      const { id } = await createLink(inviter)
      const del = (who: Account, target: string) =>
        request(http())
          .delete(url(`/invitations/${target}`))
          .set('Cookie', who.cookie)

      await del(stranger, id).expect(404)
      expect((await prisma.invitation.findUniqueOrThrow({ where: { id } })).revokedAt).toBeNull()
      await del(inviter, id).expect(204)
      await del(inviter, id).expect(204)
      await del(inviter, 'no-such-id').expect(404)
    })
  })

  describe('ліміт використань і конкурентність', () => {
    it('12 людей одночасно на посилання з 10 місцями: рівно 10 дружб, решта 410 INVITE_EXHAUSTED', async () => {
      const inviter = await register('Клуб')
      const { id, token } = await createLink(inviter)
      const guests = await Promise.all(Array.from({ length: 12 }, (_, i) => register(`Гість ${i}`)))

      const responses = await Promise.all(guests.map((guest) => accept(guest, token)))
      const statuses = responses.map((response) => response.status).sort()

      expect(statuses.filter((status) => status === 200)).toHaveLength(10)
      expect(statuses.filter((status) => status === 410)).toHaveLength(2)

      for (const response of responses.filter((r) => r.status === 410)) {
        expect(errorCode(response.body)).toBe('INVITE_EXHAUSTED')
      }

      expect(await prisma.invitationAcceptance.count({ where: { invitationId: id } })).toBe(10)
      expect(
        await prisma.friendship.count({
          where: {
            status: 'ACCEPTED',
            OR: [{ userAId: inviter.id }, { userBId: inviter.id }],
          },
        }),
      ).toBe(10)

      const list = await request(http()).get(url('/invitations')).set('Cookie', inviter.cookie)

      expect(invitationListResponseSchema.parse(list.body).invitations[0]).toMatchObject({
        status: 'EXHAUSTED',
        acceptedCount: 10,
      })
    })

    it('одна людина двічі одночасно: обидві відповіді 200, один acceptance, одна дружба', async () => {
      const inviter = await register('Подвійна')
      const invitee = await register('Двічі клікнув')
      const { id, token } = await createLink(inviter)

      const responses = await Promise.all([accept(invitee, token), accept(invitee, token)])

      expect(responses.map((response) => response.status)).toEqual([200, 200])
      expect(await prisma.invitationAcceptance.count({ where: { invitationId: id } })).toBe(1)
      expect(
        await prisma.friendship.count({
          where: {
            OR: [
              { userAId: inviter.id, userBId: invitee.id },
              { userAId: invitee.id, userBId: inviter.id },
            ],
          },
        }),
      ).toBe(1)
    })

    it('одночасні revoke і accept: або дружба з acceptance, або 410 без жодних слідів', async () => {
      const inviter = await register('Гонка')
      const invitee = await register('Гонщик')
      const { id, token } = await createLink(inviter)

      const [accepted] = await Promise.all([
        accept(invitee, token),
        request(http())
          .delete(url(`/invitations/${id}`))
          .set('Cookie', inviter.cookie),
      ])
      const friendship = await pairOf(inviter.id, invitee.id)
      const acceptances = await prisma.invitationAcceptance.count({ where: { invitationId: id } })

      if (accepted.status === 200) {
        expect(friendship).toMatchObject({ status: 'ACCEPTED' })
        expect(acceptances).toBe(1)
      } else {
        expect(accepted.status).toBe(410)
        expect(friendship).toBeNull()
        expect(acceptances).toBe(0)
      }
    })
  })

  describe('токен не потрапляє в логи й помилки', () => {
    it('ні в записах Logger, ні у відповідях-помилках, ні в ProductEvent', async () => {
      const inviter = await register('Логи')
      const invitee = await register('Логований')
      const { id, token } = await createLink(inviter)
      const seen: string[] = []
      const record = (...args: unknown[]): void => {
        seen.push(args.map((arg) => JSON.stringify(arg)).join(' '))
      }
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(record),
      )

      try {
        const bodies = [
          (await accept(invitee, token).expect(200)).text,
          (await accept(invitee, token).expect(200)).text,
          (await resolve(invitee, token).expect(200)).text,
          (await accept(invitee, `${token}x`).expect(404)).text,
          (await accept(inviter, token).expect(400)).text,
        ]

        await request(http())
          .delete(url(`/invitations/${id}`))
          .set('Cookie', inviter.cookie)
          .expect(204)
        bodies.push((await accept(await register('Пізній'), token).expect(410)).text)

        expect(seen.join('\n')).not.toContain(token)

        for (const body of bodies) expect(body).not.toContain(token)
      } finally {
        for (const spy of spies) spy.mockRestore()
      }

      const events = await prisma.productEvent.findMany({
        where: { subjectUserId: { in: [inviter.id, invitee.id] } },
      })

      expect(JSON.stringify(events)).not.toContain(token)
    })
  })
})
