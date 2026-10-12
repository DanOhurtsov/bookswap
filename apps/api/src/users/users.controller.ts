import { Body, Controller, Get, HttpStatus, Patch, Query, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { API_ERROR_CODES, type Me, type UserSearchResponse } from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { UpdateProfileDto, UserSearchDto } from './dto/user.dto'
import { toMe } from './user.mapper'
import { UsersService } from './users.service'
import type { UserModel } from '../generated/prisma/models'

/** Перебір бази по імені теж треба стримувати, хай і м'якше за логін. */
const SEARCH_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

@Controller()
@UseGuards(SessionGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** Власний профіль повністю (§9). Джерело правди для фронту після логіну. */
  @Get('me')
  me(@CurrentUser() user: UserModel): Me {
    return toMe(user)
  }

  @Patch('me')
  async updateProfile(@CurrentUser() user: UserModel, @Body() dto: UpdateProfileDto): Promise<Me> {
    // `undefined` у Prisma означає «не чіпати», тож порожній об'єкт мовчки
    // зробив би нічого і повернув 200 — відповідь, яка бреше про виконану дію.
    const changes = definedFields(dto)

    if (Object.keys(changes).length === 0) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Не передано жодного поля для зміни',
        HttpStatus.BAD_REQUEST,
      )
    }

    return this.users.updateProfile(user.id, changes)
  }

  /**
   * §6.1: `?query=` — частковий збіг по імені плюс точний збіг email, якщо значення є адресою;
   * `?q=` — лише імʼя, `?email=` — лише точна адреса (сумісність).
   *
   * Рівно один параметр: кілька разом чи жодного — це не пошук, а помилка виклику.
   */
  @Get('users')
  @UseGuards(ThrottlerGuard)
  @Throttle(SEARCH_LIMIT)
  async search(
    @CurrentUser() user: UserModel,
    @Query() dto: UserSearchDto,
  ): Promise<UserSearchResponse> {
    const given = [dto.query, dto.q, dto.email].filter((value) => value !== undefined)

    if (given.length !== 1) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Потрібен рівно один параметр: query, q або email',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (dto.query !== undefined) return { results: await this.users.search(dto.query, user.id) }
    if (dto.q !== undefined) {
      return { results: await this.users.searchByDisplayName(dto.q, user.id) }
    }

    return { results: await this.users.findByExactEmail(dto.email ?? '', user.id) }
  }
}

/** Прибирає ключі зі значенням `undefined`, лишаючи явні `null`. */
function definedFields<T extends object>(dto: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(dto).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}
