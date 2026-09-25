import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  API_ERROR_CODES,
  INVITATION_EMAIL_MAX_USES,
  INVITATION_LINK_MAX_USES,
  type AcceptInvitationResponse,
  type CreateInvitationRequest,
  type CreateInvitationResponse,
  type Invitation,
  type InvitationListResponse,
  type InvitationResolveState,
  type ResolveInvitationResponse,
} from '@bookswap/shared'
import { AccessService } from '../access/access.service'
import { AnalyticsService } from '../analytics/analytics.service'
import { generateToken, hashToken } from '../auth/tokens'
import { ApiException } from '../common/api.exception'
import { isUniqueViolation } from '../common/prisma-errors'
import { EMAIL_SENDER, type EmailSender } from '../email/email-sender'
import { FriendsService } from '../friends/friends.service'
import type { InvitationModel, UserModel } from '../generated/prisma/models'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toPublicUser } from '../users/user.mapper'
import { InviteEmailHasher } from './invite-email-hasher'
import { INVITATION_TTL_MS, invitationStatusOf } from './invitation.rules'

/** D4: не більше 10 листів на користувача за добу. */
export const EMAIL_INVITES_PER_USER_PER_DAY = 10
/** D4: не більше 3 листів на одну адресу за тиждень — від усіх запрошувачів разом. */
export const EMAIL_INVITES_PER_RECIPIENT_PER_WEEK = 3

const DAY_MS = 24 * 60 * 60 * 1000
const LIST_LIMIT = 50

type InvitationWithCount = InvitationModel & { _count: { acceptances: number } }

/**
 * Етап 9: запрошення. Дружба тут ніколи не створюється сама — лише після явного
 * `accept` запрошеного, і тільки крізь `FriendsService` (єдина точка переходів).
 */
@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly friends: FriendsService,
    private readonly analytics: AnalyticsService,
    private readonly config: ConfigService,
    private readonly emailHasher: InviteEmailHasher,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async create(
    inviter: UserModel,
    request: CreateInvitationRequest,
  ): Promise<CreateInvitationResponse> {
    return request.kind === 'LINK'
      ? this.createLink(inviter)
      : this.createEmail(inviter, request.email)
  }

  async list(inviterId: string): Promise<InvitationListResponse> {
    const rows = await this.prisma.invitation.findMany({
      where: { inviterId },
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
      include: { _count: { select: { acceptances: true } } },
    })
    const now = new Date()

    return { invitations: rows.map((row) => toInvitation(row, now)) }
  }

  /** D2: миттєво; вже створені дружби й прийняття не чіпаються. Повтор — ідемпотентний. */
  async revoke(inviterId: string, id: string): Promise<void> {
    const row = await this.prisma.invitation.findFirst({
      where: { id, inviterId },
      select: { id: true },
    })

    // Чужий і неіснуючий id — однаково 404.
    if (row === null) throw notFound()

    await this.prisma.invitation.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  async resolve(userId: string, token: string): Promise<ResolveInvitationResponse> {
    const row = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        _count: { select: { acceptances: true } },
        inviter: { select: PUBLIC_USER_FIELDS },
        acceptances: { where: { userId }, select: { id: true } },
      },
    })

    if (row === null) throw invalid()

    const relation = await this.access.relationWith(userId, row.inviterId)

    if (relation === 'BLOCKED_BY_ME' || relation === 'BLOCKED_ME') throw invalid()

    let state: InvitationResolveState

    if (row.inviterId === userId) state = 'SELF'
    else if (row.acceptances.length > 0) state = 'ALREADY_ACCEPTED'
    else state = invitationStatusOf(factsOf(row), new Date())

    return { state, inviter: toPublicUser(row.inviter), relation }
  }

  async accept(userId: string, token: string): Promise<AcceptInvitationResponse> {
    const tokenHash = hashToken(token)
    const outcome = await this.runAcceptWithRetry(userId, tokenHash)

    if (outcome.accepted !== null) await this.friends.afterAccepted(outcome.accepted)

    // Атрибуція — запрошувачу: воронка міряє, скільки його запрошень дійшло до згоди.
    if (outcome.acceptanceId !== null) {
      await this.analytics.record({
        type: 'INVITE_ACCEPTED',
        subjectUserId: outcome.inviterId,
        domainEntityId: outcome.acceptanceId,
        properties: {},
      })
    }

    return { relation: outcome.relation, inviter: outcome.inviter }
  }

  private async runAcceptWithRetry(userId: string, tokenHash: string) {
    try {
      return await this.acceptOnce(userId, tokenHash)
    } catch (error) {
      // Гонка на створенні пари: вся транзакція повторюється, а не її хвіст —
      // після порушення обмеження Postgres не дозволяє продовжити ту саму.
      if (!isUniqueViolation(error)) throw error

      this.logger.log('Гонка при прийнятті запрошення — повтор')

      return await this.acceptOnce(userId, tokenHash)
    }
  }

  private acceptOnce(userId: string, tokenHash: string) {
    return this.prisma.$transaction(async (tx) => {
      // Блокування рядка запрошення серіалізує конкурентні прийняття: перевірка
      // ліміту й вставка acceptance не можуть перемішатися між двома людьми.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Invitation" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`

      const lockedId = locked[0]?.id

      if (lockedId === undefined) throw invalid()

      const row = await tx.invitation.findUniqueOrThrow({
        where: { id: lockedId },
        include: {
          _count: { select: { acceptances: true } },
          inviter: { select: PUBLIC_USER_FIELDS },
          acceptances: { where: { userId }, select: { id: true } },
        },
      })
      const inviter = toPublicUser(row.inviter)

      if (row.inviterId === userId) {
        throw new ApiException(
          API_ERROR_CODES.INVITE_SELF,
          'Це ваше власне запрошення',
          HttpStatus.BAD_REQUEST,
        )
      }

      // Повторне відкриття тим самим користувачем — ідемпотентне, навіть якщо
      // запрошення відтоді відкликали чи воно прострочилось.
      if (row.acceptances.length > 0) {
        const relation = await this.access.relationWith(userId, row.inviterId, tx)

        return { relation, inviter, inviterId: row.inviterId, accepted: null, acceptanceId: null }
      }

      const status = invitationStatusOf(factsOf(row), new Date())

      if (status === 'REVOKED') throw gone(API_ERROR_CODES.INVITE_REVOKED, 'Запрошення відкликано')
      if (status === 'EXPIRED') throw gone(API_ERROR_CODES.INVITE_EXPIRED, 'Строк запрошення минув')
      if (status === 'EXHAUSTED') {
        throw gone(API_ERROR_CODES.INVITE_EXHAUSTED, 'Запрошення вже використане')
      }

      const result = await this.friends.acceptInviteIn(tx, userId, row.inviterId)

      // Блок (у будь-який бік) — та сама відповідь, що й на невідомий токен.
      if (result === null) throw invalid()

      // Уже друзі: використання не витрачається, запису прийняття немає.
      let acceptanceId: string | null = null

      if (result.accepted !== null) {
        const acceptance = await tx.invitationAcceptance.create({
          data: { invitationId: row.id, userId },
        })

        acceptanceId = acceptance.id
      }

      return {
        relation: result.relation,
        inviter,
        inviterId: row.inviterId,
        accepted: result.accepted,
        acceptanceId,
      }
    })
  }

  private async createLink(inviter: UserModel): Promise<CreateInvitationResponse> {
    const token = generateToken()
    const row = await this.prisma.invitation.create({
      data: {
        inviterId: inviter.id,
        kind: 'LINK',
        tokenHash: hashToken(token),
        maxUses: INVITATION_LINK_MAX_USES,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
    })

    await this.recordSent(inviter.id, row.id)

    return { invitation: toInvitation({ ...row, _count: { acceptances: 0 } }, new Date()), token }
  }

  private async createEmail(inviter: UserModel, email: string): Promise<CreateInvitationResponse> {
    if (!inviter.emailVerified) {
      throw new ApiException(
        API_ERROR_CODES.INVITE_EMAIL_UNVERIFIED,
        'Щоб надсилати запрошення поштою, підтвердьте власну адресу',
        HttpStatus.FORBIDDEN,
      )
    }

    const token = generateToken()
    const recipientEmailHash = this.emailHasher.hash(email)
    const now = new Date()

    const row = await this.prisma.$transaction(async (tx) => {
      // Advisory-блокування, а не «порахувати й вставити»: два паралельні запити
      // одного запрошувача не мають права разом пролізти повз ліміт.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite-user:${inviter.id}`}))`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`invite-rcpt:${recipientEmailHash}`}))`

      const perUser = await tx.invitation.count({
        where: {
          inviterId: inviter.id,
          kind: 'EMAIL',
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
        },
      })
      const perRecipient = await tx.invitation.count({
        where: {
          recipientEmailHash,
          createdAt: { gt: new Date(now.getTime() - 7 * DAY_MS) },
        },
      })

      if (
        perUser >= EMAIL_INVITES_PER_USER_PER_DAY ||
        perRecipient >= EMAIL_INVITES_PER_RECIPIENT_PER_WEEK
      ) {
        throw new ApiException(
          API_ERROR_CODES.INVITE_RATE_LIMITED,
          'Забагато запрошень поштою. Спробуйте пізніше або поділіться посиланням.',
          HttpStatus.TOO_MANY_REQUESTS,
        )
      }

      return tx.invitation.create({
        data: {
          inviterId: inviter.id,
          kind: 'EMAIL',
          tokenHash: hashToken(token),
          recipientEmailHash,
          maxUses: INVITATION_EMAIL_MAX_USES,
          expiresAt: new Date(now.getTime() + INVITATION_TTL_MS),
        },
      })
    })

    // Відповідь однакова, чи є в адреси акаунт: лист іде в обох випадках.
    // Синхронно й без черги (D5): збій провайдера — відповідь 502, а токен, який
    // ніхто не отримає, одразу гаситься, щоб не висіти чинним.
    try {
      await this.email.send({
        to: email,
        subject: `${headerSafe(inviter.displayName)} запрошує вас до BookSwap`,
        body:
          `${inviter.displayName} запрошує вас до BookSwap — приватної бібліотеки друзів.\n\n` +
          `Відкрийте посилання, увійдіть чи зареєструйтеся й підтвердьте дружбу:\n` +
          `${this.link(token)}\n\n` +
          `Посилання дійсне 14 днів і працює один раз; ним може скористатися той, ` +
          `хто його має. Якщо ви не знаєте цієї людини, просто проігноруйте лист.`,
        idempotencyKey: `invite:${row.id}`,
      })
    } catch (error) {
      await this.prisma.invitation.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      })
      this.logger.warn(
        `Лист-запрошення ${row.id} не надіслано: ${error instanceof Error ? error.name : 'помилка'}`,
      )

      throw new ApiException(
        API_ERROR_CODES.INVITE_EMAIL_FAILED,
        'Не вдалося надіслати лист. Це запрошення скасовано — створіть нове.',
        HttpStatus.BAD_GATEWAY,
      )
    }

    await this.recordSent(inviter.id, row.id)

    return { invitation: toInvitation({ ...row, _count: { acceptances: 0 } }, now) }
  }

  /** `invite_sent`: посилання створено або лист прийнято провайдером. Без адреси й токена. */
  private recordSent(inviterId: string, invitationId: string): Promise<void> {
    return this.analytics.record({
      type: 'INVITE_SENT',
      subjectUserId: inviterId,
      domainEntityId: invitationId,
      properties: {},
    })
  }

  /** Токен — у фрагменті: він не йде на сервер, у логи проксі й у `Referer`. */
  private link(token: string): string {
    return `${this.config.getOrThrow<string>('WEB_ORIGIN')}/invite#${encodeURIComponent(token)}`
  }
}

function factsOf(row: InvitationWithCount) {
  return {
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    acceptedCount: row._count.acceptances,
    maxUses: row.maxUses,
  }
}

function toInvitation(row: InvitationWithCount, now: Date): Invitation {
  return {
    id: row.id,
    kind: row.kind,
    status: invitationStatusOf(factsOf(row), now),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    acceptedCount: row._count.acceptances,
    maxUses: row.maxUses,
  }
}

function headerSafe(value: string): string {
  let result = ''

  for (const char of value) result += char.charCodeAt(0) < 0x20 ? ' ' : char

  return result.replace(/ {2,}/g, ' ').trim()
}

function invalid(): ApiException {
  return new ApiException(
    API_ERROR_CODES.INVITE_INVALID,
    'Запрошення недійсне',
    HttpStatus.NOT_FOUND,
  )
}

function notFound(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Запрошення не знайдено', HttpStatus.NOT_FOUND)
}

function gone(code: 'INVITE_REVOKED' | 'INVITE_EXPIRED' | 'INVITE_EXHAUSTED', message: string) {
  return new ApiException(API_ERROR_CODES[code], message, HttpStatus.GONE)
}
