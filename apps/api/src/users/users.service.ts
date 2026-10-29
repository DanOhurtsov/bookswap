import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  USER_SEARCH_LIMIT,
  emailSchema,
  isReservedHandle,
  type Me,
  type PublicUser,
  type UpdateProfileRequest,
  type UserSearchResult,
} from '@bookswap/shared'
import { AccessService } from '../access/access.service'
import { ApiException } from '../common/api.exception'
import { isUniqueViolationOn } from '../common/prisma-errors'
import { PrismaService } from '../prisma/prisma.service'
import { PUBLIC_USER_FIELDS, toMe, toPublicUser, type PublicUserRow } from './user.mapper'

/** §9: стороннім видно лише імʼя, нік (BS-148) та аватар — вибірка обмежена вже на рівні запиту. */
const PUBLIC_FIELDS = PUBLIC_USER_FIELDS

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async updateProfile(userId: string, changes: UpdateProfileRequest): Promise<Me> {
    if (changes.handle !== undefined && isReservedHandle(changes.handle)) throw handleTaken()

    try {
      return toMe(await this.prisma.user.update({ where: { id: userId }, data: changes }))
    } catch (error) {
      // A nickname free at the availability check can be taken by the time of saving: the unique
      // index has the last word.
      if (isUniqueViolationOn(error, 'User_handle_key')) throw handleTaken()
      throw error
    }
  }

  /** BS-148: free, or already the viewer's own. Reserved names are never free (`HANDLE_RULES`). */
  async isHandleAvailable(handle: string, viewerId: string): Promise<boolean> {
    if (isReservedHandle(handle)) return false

    const owner = await this.prisma.user.findUnique({ where: { handle }, select: { id: true } })

    return owner === null || owner.id === viewerId
  }

  /**
   * BS-148: the person behind an address — `/u/<handle>`, or an old `/users/<id>/library` link.
   *
   * An unknown person and one in a blocked pair (either direction) answer alike — 404, so the address
   * does not tell a blocked person that the account behind it exists (PO decision, 26.10.2026).
   */
  async findPerson(
    where: { id: string } | { handle: string },
    viewerId: string,
  ): Promise<PublicUser> {
    const person = await this.prisma.user.findUnique({ where, select: PUBLIC_FIELDS })

    if (person === null || (await this.access.isBlocked(viewerId, person.id))) {
      throw new ApiException(
        API_ERROR_CODES.NOT_FOUND,
        'Користувача не знайдено',
        HttpStatus.NOT_FOUND,
      )
    }

    return toPublicUser(person)
  }

  /**
   * One search field: everyone whose name contains `query`, OR whose address is exactly
   * `query` when it is a complete valid email — a union, not a choice of one mode.
   *
   * The exact address match comes first: it names one specific person. Duplicates
   * (the same person matched both ways) are dropped by id, and the limit applies to the final
   * list. The address is normalized exactly as at registration, and only ever compared whole.
   */
  async search(query: string, viewerId: string): Promise<UserSearchResult[]> {
    const email = emailSchema.safeParse(query)
    const [byEmail, byName] = await Promise.all([
      email.success
        ? this.prisma.user.findUnique({ where: { email: email.data }, select: PUBLIC_FIELDS })
        : null,
      this.findByDisplayName(query, viewerId),
    ])
    const first = byEmail === null || byEmail.id === viewerId ? [] : [byEmail]
    const users = [...first, ...byName.filter((user) => user.id !== byEmail?.id)]

    return this.annotate(users.slice(0, USER_SEARCH_LIMIT), viewerId)
  }

  /** `?q=`: the name only (§6.1). */
  async searchByDisplayName(query: string, viewerId: string): Promise<UserSearchResult[]> {
    return this.annotate(await this.findByDisplayName(query, viewerId), viewerId)
  }

  /**
   * Пошук за імʼям — частковий збіг без урахування регістру (§6.1).
   *
   * `contains`, а не тріграмна схожість: GIN-індекси §4.9 стоять на каталозі, і
   * заводити нечіткий пошук по людях, поки їх десятки, — вирішувати неіснуючу
   * проблему. Ліміт при цьому є, і він той самий, що бачить фронт.
   */
  private findByDisplayName(query: string, viewerId: string): Promise<PublicUserRow[]> {
    return this.prisma.user.findMany({
      where: {
        displayName: { contains: query, mode: 'insensitive' },
        // Себе в результатах пошуку людей немає: додати себе в друзі не можна,
        // а рядок у видачі лише плутає.
        id: { not: viewerId },
      },
      select: PUBLIC_FIELDS,
      orderBy: { displayName: 'asc' },
      take: USER_SEARCH_LIMIT,
    })
  }

  /**
   * Пошук за поштою — тільки точний збіг (§6.1).
   *
   * Порожній результат і знайдений користувач відрізняються, і це свідомо: інакше
   * неможливо додати в друзі того, чию адресу тобі дали. Але підбирати адресу по
   * частинах не можна — саме тому тут немає ні `contains`, ні `startsWith`.
   */
  async findByExactEmail(email: string, viewerId: string): Promise<UserSearchResult[]> {
    const user = await this.prisma.user.findUnique({ where: { email }, select: PUBLIC_FIELDS })

    if (user === null || user.id === viewerId) return []

    return this.annotate([user], viewerId)
  }

  /**
   * Дописує до знайдених людей стан звʼязку з ними.
   *
   * Рахує `AccessService`, а не фронт: інакше клієнт мусив би перетинати списки
   * друзів і запитів сам — тобто продублювати авторизаційну логіку за мережею, ще
   * й без доступу до заблокованих пар, яких немає в жодному зі списків.
   *
   * Один запит на весь список (`relationsWith`), не по запиту на людину.
   */
  private async annotate(users: PublicUserRow[], viewerId: string): Promise<UserSearchResult[]> {
    const relations = await this.access.relationsWith(
      viewerId,
      users.map((user) => user.id),
    )

    return users.map((user) => ({
      user: toPublicUser(user),
      relation: relations.get(user.id) ?? 'NONE',
    }))
  }
}

function handleTaken(): ApiException {
  return new ApiException(API_ERROR_CODES.HANDLE_TAKEN, 'Цей нік уже зайнятий', HttpStatus.CONFLICT)
}
