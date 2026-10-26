import { HttpStatus, Injectable } from '@nestjs/common'
import { API_ERROR_CODES, type FriendRelation } from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { PrismaService } from '../prisma/prisma.service'
import { normalizePair, otherIdOf, relationOf, type FriendshipRecord } from './friendship.pair'
import type { ViewerRole } from './visibility'
import type { FriendshipModel } from '../generated/prisma/models'

/**
 * Приймає і `PrismaService`, і `tx` із транзакції — той самий структурний прийом,
 * що вже застосований у `SessionService.revokeAllForUser`.
 */
export type FriendshipReader = Pick<PrismaService, 'friendship'>

/**
 * Єдине місце, де питання «а чи можна цьому це бачити» перетворюється на запит
 * до бази.
 *
 * §9 — це таблиця, і вона мусить лишатися таблицею. Щойно `findFirst` по
 * `Friendship` з'явиться у другому контролері, таблиця перетвориться на набір
 * умов, які розходяться поодинці й мовчки. Тому будь-який модуль, якому треба
 * знати про дружбу або видимість, ходить сюди, а не в Prisma.
 *
 * Самі правила видимості живуть у `visibility.ts` чистими функціями; цей сервіс
 * лише постачає їм роль. Розділення навмисне — воно й робить матрицю §9
 * тестованою без бази.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Рядок пари, якщо він є.
   *
   * Через `normalizePair` — саме заради цього існує інваріант `userAId < userBId`
   * (§4.3): один `findUnique` замість `OR` із двох умов.
   */
  async findPair(
    oneId: string,
    otherId: string,
    client: FriendshipReader = this.prisma,
  ): Promise<FriendshipModel | null> {
    if (oneId === otherId) return null

    return client.friendship.findUnique({
      where: { userAId_userBId: normalizePair(oneId, otherId) },
    })
  }

  /** Стан пари з погляду того, хто питає. */
  async relationWith(
    viewerId: string,
    otherId: string,
    client: FriendshipReader = this.prisma,
  ): Promise<FriendRelation> {
    if (viewerId === otherId) return 'NONE'

    return relationOf(await this.findPair(viewerId, otherId, client), viewerId)
  }

  /**
   * Роль для матриці §9 — міст між базою і чистими функціями `visibility.ts`.
   *
   * Друг — це саме `ACCEPTED`. Ні `PENDING`, ні `DECLINED` доступу не дають: запит
   * у друзі не є дружбою, і бачити бібліотеку до відповіді не можна.
   *
   * `BLOCKED` — окрема роль, а не `OTHER`. Звести його до «стороннього» означало б
   * лишити заблокованому доступ до `PUBLIC`-бібліотеки, а §6.2 каже «не бачить
   * бібліотеку» без застережень про `Visibility`. Різниця помітна не одразу — саме
   * тому вона тут, в одному місці, а не в кожному контролері окремо.
   */
  async roleOf(
    viewerId: string,
    ownerId: string,
    client: FriendshipReader = this.prisma,
  ): Promise<ViewerRole> {
    if (viewerId === ownerId) return 'OWNER'

    const friendship = await this.findPair(viewerId, ownerId, client)

    if (friendship?.status === 'BLOCKED') return 'BLOCKED'

    return friendship?.status === 'ACCEPTED' ? 'FRIEND' : 'OTHER'
  }

  /** §6.2: блокування симетричне в частині доступу — напрямок тут не важить. */
  async isBlocked(
    viewerId: string,
    otherId: string,
    client: FriendshipReader = this.prisma,
  ): Promise<boolean> {
    const friendship = await this.findPair(viewerId, otherId, client)

    return friendship?.status === 'BLOCKED'
  }

  /** Те саме, але кидає — щоб виклик читався як передумова, а не як `if`. */
  async assertNotBlocked(
    viewerId: string,
    otherId: string,
    client: FriendshipReader = this.prisma,
  ): Promise<void> {
    if (await this.isBlocked(viewerId, otherId, client)) throw blocked()
  }

  /**
   * BS-137: id поточних друзів — лише `ACCEPTED`. `PENDING`, `DECLINED` і `BLOCKED` друзями не є (як і в
   * `roleOf`), а видалена дружба чи видалений акаунт рядка не мають зовсім. Один запит на всіх друзів.
   */
  async acceptedFriendIds(userId: string): Promise<string[]> {
    const friendships = await this.prisma.friendship.findMany({
      where: { status: 'ACCEPTED', OR: [{ userAId: userId }, { userBId: userId }] },
      select: { userAId: true, userBId: true },
    })

    return friendships.map((friendship) => otherIdOf(friendship, userId))
  }

  /**
   * Стан звʼязку одразу для списку людей — для пошуку (§6.1).
   *
   * Один запит на весь список, не по запиту на рядок: пошук віддає до
   * `USER_SEARCH_LIMIT` результатів, і N+1 тут перетворив би одну сторінку на
   * два десятки звернень до бази.
   */
  async relationsWith(viewerId: string, otherIds: string[]): Promise<Map<string, FriendRelation>> {
    const relations = new Map<string, FriendRelation>()

    if (otherIds.length === 0) return relations

    const friendships = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { userAId: viewerId, userBId: { in: otherIds } },
          { userBId: viewerId, userAId: { in: otherIds } },
        ],
      },
    })

    for (const friendship of friendships) {
      const otherId = friendship.userAId === viewerId ? friendship.userBId : friendship.userAId

      relations.set(otherId, relationOf(friendship, viewerId))
    }

    return relations
  }
}

/** Один код на всі відмови через блокування — §6.2 не розрізняє їхніх причин. */
export function blocked(message = 'Дія недоступна: пару заблоковано'): ApiException {
  return new ApiException(API_ERROR_CODES.FRIENDSHIP_BLOCKED, message, HttpStatus.FORBIDDEN)
}

// Компіляційна перевірка: модель Prisma задовольняє структурний тип чистих функцій.
// Якщо в схемі зникне `blockedById`, зламається саме тут, а не в рантаймі.
const _recordShape: (model: FriendshipModel) => FriendshipRecord = (model) => model
void _recordShape
