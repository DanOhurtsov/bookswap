import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type FriendListResponse,
  type FriendRelation,
  type FriendRequestAction,
  type FriendRequestsResponse,
} from '@bookswap/shared'
import { AccessService, blocked, type FriendshipReader } from '../access/access.service'
import { AnalyticsService } from '../analytics/analytics.service'
import { NetworkActivationService } from '../analytics/network-activation.service'
import {
  actorRoleOf,
  isMember,
  normalizePair,
  otherIdOf,
  relationOf,
  stateOf,
  type FriendshipRecord,
} from '../access/friendship.pair'
import { ApiException } from '../common/api.exception'
import { isUniqueViolation } from '../common/prisma-errors'
import {
  NotificationsService,
  type NotificationWriter,
} from '../notifications/notifications.service'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS } from '../users/user.mapper'
import { toFriend, toFriendRequest } from './friends.mapper'
import {
  resolveTransition,
  type FriendshipAction,
  type RefusalReason,
} from './friendship.transitions'
import type { FriendshipModel } from '../generated/prisma/models'
import type { Prisma } from '../generated/prisma/client'

/**
 * Чим саме адресована зміна.
 *
 * §8 має обидва способи: `DELETE /friends/:userId` і `POST /friends/:userId/block`
 * говорять про людину, `PATCH /friends/requests/:id` — про конкретний рядок.
 * Тип робить цю різницю явною, бо від неї залежить коректність (див. `locate`).
 */
export type FriendshipTarget =
  { kind: 'user'; userId: string } | { kind: 'request'; requestId: string }

interface FriendshipTransitionOutcome {
  relation: FriendRelation
  accepted: { friendshipId: string; userAId: string; userBId: string } | null
}

/** Обидва учасники потрібні для §9-проєкції в списках. */
const WITH_USERS = {
  userA: { select: PUBLIC_USER_FIELDS },
  userB: { select: PUBLIC_USER_FIELDS },
} as const

/**
 * §6.2. Єдине місце, де змінюється `Friendship.status`.
 *
 * Те саме правило, яке §5 ставить лоанам: усі переходи — крізь один метод. Тут це
 * `apply()`, і всі чотири мутуючі маршрути §8 проходять крізь нього. Контролер не
 * бачить жодного статусу, а рішення «можна чи ні» ухвалює чиста
 * `resolveTransition()`, яка не має доступу до бази.
 */
@Injectable()
export class FriendsService {
  private readonly logger = new Logger(FriendsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly analytics: AnalyticsService,
    private readonly network: NetworkActivationService,
    private readonly notifications: NotificationsService,
  ) {}

  async listFriends(userId: string): Promise<FriendListResponse> {
    const rows = await this.prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [{ userAId: userId }, { userBId: userId }] },
      include: WITH_USERS,
      orderBy: { respondedAt: 'desc' },
    })

    return { friends: rows.map((row) => toFriend(row, userId)) }
  }

  /**
   * §8: вхідні й вихідні одним відгуком.
   *
   * Один запит, поділений у пам'яті за `requestedById`: два окремі запити дали б
   * неузгоджений зріз, у якому щойно прийнятий запит видно двічі.
   */
  async listRequests(userId: string): Promise<FriendRequestsResponse> {
    const rows = await this.prisma.friendship.findMany({
      where: { status: 'PENDING', OR: [{ userAId: userId }, { userBId: userId }] },
      include: WITH_USERS,
      orderBy: { createdAt: 'desc' },
    })

    return {
      incoming: rows
        .filter((row) => row.requestedById !== userId)
        .map((row) => toFriendRequest(row, userId)),
      outgoing: rows
        .filter((row) => row.requestedById === userId)
        .map((row) => toFriendRequest(row, userId)),
    }
  }

  async request(actorId: string, targetId: string): Promise<FriendRelation> {
    if (actorId === targetId) {
      throw new ApiException(
        API_ERROR_CODES.FRIENDSHIP_SELF,
        'Не можна надіслати запит самому собі',
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.assertUserExists(targetId)

    return this.apply(actorId, { kind: 'user', userId: targetId }, 'request')
  }

  /**
   * §8 адресує запит його id, а не id людини.
   *
   * Саме `requestId` і йде далі як ціль: рядок читається **всередині** транзакції
   * і за id, а не за парою. Читання за парою тут було б помилкою — між читанням
   * запиту й записом його можна скасувати й створити новий для тієї самої пари,
   * і тоді PATCH зі старим id мовчки змінив би вже інший запит.
   */
  async respond(
    actorId: string,
    requestId: string,
    action: FriendRequestAction,
  ): Promise<FriendRelation> {
    return this.apply(actorId, { kind: 'request', requestId }, action)
  }

  async remove(actorId: string, otherId: string): Promise<void> {
    await this.apply(actorId, { kind: 'user', userId: otherId }, 'remove')
  }

  async block(actorId: string, otherId: string): Promise<void> {
    if (actorId === otherId) {
      throw new ApiException(
        API_ERROR_CODES.FRIENDSHIP_SELF,
        'Не можна заблокувати самого себе',
        HttpStatus.BAD_REQUEST,
      )
    }

    await this.assertUserExists(otherId)
    await this.apply(actorId, { kind: 'user', userId: otherId }, 'block')
  }

  /**
   * Етап 9: прийняття запрошення. Викликається з `InvitationsService` усередині
   * ЙОГО транзакції — дружба й запис прийняття мають бути атомарними, інакше
   * лічильник використань розійшовся б із реальними дружбами.
   *
   * Будь-яка відмова (у т.ч. блок) віддається як `null`: вирішує викликач, і
   * причина назовні не розкривається.
   */
  async acceptInviteIn(
    tx: Prisma.TransactionClient,
    inviteeId: string,
    inviterId: string,
  ): Promise<{
    relation: FriendRelation
    accepted: FriendshipTransitionOutcome['accepted']
  } | null> {
    try {
      const outcome = await this.transitionIn(
        tx,
        inviteeId,
        { kind: 'user', userId: inviterId },
        'invite',
      )

      return outcome
    } catch (error) {
      if (error instanceof ApiException) return null

      throw error
    }
  }

  /** Побічні ефекти прийнятої дружби після коміту зовнішньої транзакції. */
  async afterAccepted(
    accepted: NonNullable<FriendshipTransitionOutcome['accepted']>,
  ): Promise<void> {
    this.notifications.dispatchSoon()
    await this.recordAccepted(accepted)
  }

  private async recordAccepted(
    accepted: NonNullable<FriendshipTransitionOutcome['accepted']>,
  ): Promise<void> {
    for (const subjectUserId of [accepted.userAId, accepted.userBId]) {
      await this.analytics.record({
        type: 'FRIEND_ACCEPTED',
        subjectUserId,
        domainEntityId: accepted.friendshipId,
        properties: {},
      })
    }

    await this.network.onFriendshipAccepted(accepted.userAId, accepted.userBId)
  }

  /**
   * Єдина точка входу для будь-якої зміни звʼязку.
   *
   * Повтор при `P2002` ловиться **зовні** транзакції, і це не стилістика: порушення
   * обмеження перериває транзакцію Postgres цілком, тож продовжити роботу в ній
   * після `catch` неможливо — наступний запит впаде з `25P02`. Тому повторюється
   * вся транзакція, і на другому проході рядок від суперника вже видно: сценарій
   * «обидва натиснули одночасно» сходиться до `ACCEPTED` замість 409.
   */
  private async apply(
    actorId: string,
    target: FriendshipTarget,
    action: FriendshipAction,
  ): Promise<FriendRelation> {
    const outcome = await this.runWithRetry(actorId, target, action)

    // §7.3: «після коміту: подія». Тут, а не всередині транзакції: поштовх,
    // надісланий звідти, розбудив би диспетчер на рядки, яких ще не видно.
    this.notifications.dispatchSoon()

    if (outcome.accepted !== null) await this.recordAccepted(outcome.accepted)

    return outcome.relation
  }

  private async runWithRetry(
    actorId: string,
    target: FriendshipTarget,
    action: FriendshipAction,
  ): Promise<FriendshipTransitionOutcome> {
    try {
      return await this.runTransition(actorId, target, action)
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      this.logger.log(`Гонка на створенні пари для ${actorId} — повтор переходу ${action}`)

      return await this.runTransition(actorId, target, action)
    }
  }

  /**
   * Знаходить рядок, з яким працює перехід, — **усередині** транзакції.
   *
   * Цілей дві, і різниця між ними важлива:
   *
   * - `user` — маршрути, що адресують людину (`DELETE /friends/:userId`,
   *   `POST /friends/:userId/block`, створення запиту). Тут ціль — «поточний
   *   звʼязок із цією людиною», яким би він не був.
   * - `request` — `PATCH /friends/requests/:id`, який адресує КОНКРЕТНИЙ рядок.
   *   Читати його за парою було б помилкою: `cuid` видаленого рядка ніколи не
   *   повертається, тож якщо запит скасували й створили новий для тієї самої пари,
   *   пошук за парою віддав би новий рядок — і стара вкладка з давнім id прийняла
   *   б чужий, щойно створений запит. Пошук за id у тій самій транзакції робить
   *   це неможливим: рядка з таким id уже немає, і відповідь — 404.
   */
  private async locate(
    actorId: string,
    target: FriendshipTarget,
    tx: FriendshipReader,
  ): Promise<{ friendship: FriendshipModel | null; otherId: string }> {
    if (target.kind === 'user') {
      return {
        friendship: await this.access.findPair(actorId, target.userId, tx),
        otherId: target.userId,
      }
    }

    const friendship = await tx.friendship.findUnique({ where: { id: target.requestId } })

    // Чужий запит, неіснуючий і застарілий — однаково 404: інакше ендпоінт
    // повідомляє, які id рядків існують у базі.
    if (friendship === null || !isMember(friendship, actorId)) throw notFound('Запит не знайдено')

    return { friendship, otherId: otherIdOf(friendship, actorId) }
  }

  private runTransition(
    actorId: string,
    target: FriendshipTarget,
    action: FriendshipAction,
  ): Promise<FriendshipTransitionOutcome> {
    return this.prisma.$transaction((tx) => this.transitionIn(tx, actorId, target, action))
  }

  private async transitionIn(
    tx: Prisma.TransactionClient,
    actorId: string,
    target: FriendshipTarget,
    action: FriendshipAction,
  ): Promise<FriendshipTransitionOutcome> {
    const { friendship, otherId } = await this.locate(actorId, target, tx)
    const outcome = resolveTransition(stateOf(friendship), action, actorRoleOf(friendship, actorId))

    if (outcome.kind === 'refused') throw refusal(outcome.reason, action)

    const now = new Date()

    if (outcome.kind === 'create') {
      const created = await tx.friendship.create({
        data: {
          ...normalizePair(actorId, otherId),
          status: outcome.status,
          // Колонка NOT NULL навіть для блокування «з незнайомих»: єдине
          // осмислене значення — той, хто діяв. Крім прийняття запрошення:
          // ініціатор там запрошувач, і саме його сповіщає `notify`.
          requestedById: action === 'invite' ? otherId : actorId,
          blockedById: outcome.status === 'BLOCKED' ? actorId : null,
          respondedAt: outcome.status === 'PENDING' ? null : now,
        },
      })

      await this.notify(tx, created, actorId)

      return {
        relation: relationOf(created, actorId),
        accepted:
          created.status === 'ACCEPTED'
            ? { friendshipId: created.id, userAId: created.userAId, userBId: created.userBId }
            : null,
      }
    }

    if (outcome.kind === 'unchanged') {
      return { relation: relationOf(friendship, actorId), accepted: null }
    }

    // Сюди можна дійти лише з наявного стану, тобто рядок є. Перевірка потрібна
    // компілятору, а не логіці.
    if (friendship === null) throw new Error('Недосяжно: перехід без рядка мусив бути create')

    if (outcome.kind === 'delete') {
      // §5.2: активні `Loan` не чіпаються — фізична книжка все одно в когось.
      const deleted = await tx.friendship.deleteMany({
        where: { id: friendship.id, status: friendship.status },
      })

      this.assertSingleRow(deleted.count)

      return { relation: 'NONE', accepted: null }
    }

    const after: FriendshipRecord = {
      userAId: friendship.userAId,
      userBId: friendship.userBId,
      status: outcome.to,
      requestedById: outcome.to === 'PENDING' ? actorId : friendship.requestedById,
      blockedById: outcome.to === 'BLOCKED' ? actorId : friendship.blockedById,
    }

    // Умова на `status` у самому UPDATE, а не перевірка перед ним: дві паралельні
    // спроби змінити той самий рядок дають рівно одну з `count = 1`. Той самий
    // прийом, яким `AuthService` тримає одноразовість токенів із листів.
    const updated = await tx.friendship.updateMany({
      where: { id: friendship.id, status: friendship.status },
      data: {
        status: after.status,
        requestedById: after.requestedById,
        blockedById: after.blockedById,
        // Повторний запит після відмови — це знову «відповіді ще немає».
        respondedAt: after.status === 'PENDING' ? null : now,
      },
    })

    this.assertSingleRow(updated.count)

    await this.notify(tx, { ...friendship, ...after }, actorId)

    return {
      relation: relationOf(after, actorId),
      accepted:
        after.status === 'ACCEPTED'
          ? {
              friendshipId: friendship.id,
              userAId: friendship.userAId,
              userBId: friendship.userBId,
            }
          : null,
    }
  }

  /**
   * §7.5: негайних сповіщень про дружбу рівно два — запит і згода.
   *
   * Ні відмова, ні блокування, ні видалення сповіщень не породжують: §7.5 їх не
   * перелічує, і це не пропуск. «Вас відхилили» — повідомлення, яке нікому не
   * допомагає, а «вас заблокували» ще й підказує, що варто завести другий акаунт.
   *
   * Виклик усередині транзакції — §7.3, правило 1.
   */
  private async notify(
    tx: NotificationWriter,
    friendship: FriendshipRecord & { id: string },
    actorId: string,
  ): Promise<void> {
    const payload = { actorId, friendshipId: friendship.id }

    if (friendship.status === 'PENDING') {
      await this.notifications.create(
        {
          userId: otherOf(friendship, actorId),
          type: 'FRIEND_REQUESTED',
          payload,
        },
        tx,
      )

      return
    }

    if (friendship.status === 'ACCEPTED') {
      // Дякуємо тому, хто просив (чи запрошував): діє завжди інша сторона.
      await this.notifications.create(
        { userId: otherOf(friendship, actorId), type: 'FRIEND_ACCEPTED', payload },
        tx,
      )
    }
  }

  private assertSingleRow(count: number): void {
    if (count !== 1) {
      throw new ApiException(
        API_ERROR_CODES.CONFLICT,
        'Звʼязок щойно змінив хтось інший — оновіть сторінку',
        HttpStatus.CONFLICT,
      )
    }
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } })

    if (user === null) throw notFound('Користувача не знайдено')
  }
}

function otherOf(
  friendship: Pick<FriendshipRecord, 'userAId' | 'userBId'>,
  userId: string,
): string {
  return friendship.userAId === userId ? friendship.userBId : friendship.userAId
}

/**
 * Переклад відмови стейт-машини у відповідь HTTP.
 *
 * Тут і тільки тут: чиста машина не знає про HTTP, а контролер не знає про статуси.
 */
function refusal(reason: RefusalReason, action: FriendshipAction): ApiException {
  switch (reason) {
    case 'BLOCKED':
      return blocked(
        action === 'remove'
          ? 'Зняти блокування може лише той, хто його поставив'
          : 'Дія недоступна: пару заблоковано',
      )
    case 'EXISTS':
      return new ApiException(
        API_ERROR_CODES.FRIENDSHIP_EXISTS,
        'Запит уже надіслано або ви вже друзі',
        HttpStatus.CONFLICT,
      )
    case 'ROLE':
      return new ApiException(
        API_ERROR_CODES.FORBIDDEN,
        'Відповісти на запит може лише той, кому його надіслали',
        HttpStatus.FORBIDDEN,
      )
    case 'STATE':
      // «Прибрати те, чого немає» — це 404, а не конфлікт станів.
      return action === 'remove'
        ? notFound('Звʼязку з цим користувачем немає')
        : new ApiException(
            API_ERROR_CODES.FRIENDSHIP_INVALID_TRANSITION,
            'Дія неможлива в поточному стані дружби',
            HttpStatus.CONFLICT,
          )
  }
}

function notFound(message: string): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, message, HttpStatus.NOT_FOUND)
}
