import { Body, Controller, Get, HttpStatus, Param, Patch, Query, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import {
  API_ERROR_CODES,
  type HandleAvailability,
  type Me,
  type ProfileSummary,
  type PublicUser,
  type UserSearchResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { HandleParamDto, UpdateProfileDto, UserSearchDto } from './dto/user.dto'
import { ProfileSummaryService } from './profile-summary/profile-summary.service'
import { toMe } from './user.mapper'
import { UsersService } from './users.service'
import type { UserModel } from '../generated/prisma/models'

/** Перебір бази по імені теж треба стримувати, хай і м'якше за логін. */
const SEARCH_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

/**
 * BS-148: the edit form asks once per pause in typing (400 ms), so a person needs a few dozen a minute
 * at most; more is someone listing which nicknames exist.
 */
const HANDLE_AVAILABILITY_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

/** BS-148: opening `/u/<handle>` says whether the nickname exists, so it is held to the same pace. */
const HANDLE_LOOKUP_LIMIT = { auth: { limit: 60, ttl: 60_000 } }

@Controller()
@UseGuards(SessionGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly profileSummary: ProfileSummaryService,
  ) {}

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

  /** BS-148: what the profile page shows beyond `Me` — always the caller's own. */
  @Get('me/profile-summary')
  summary(@CurrentUser() user: UserModel): Promise<ProfileSummary> {
    return this.profileSummary.summaryOf(user.id)
  }

  /**
   * BS-148: whether the viewer may take this nickname. Answers only free/not free — never whose it
   * is. A malformed nickname is a 400 (`HandleParamDto`), not «taken»: the form checks the format
   * itself before asking.
   */
  @Get('users/handles/:handle/availability')
  @UseGuards(ThrottlerGuard)
  @Throttle(HANDLE_AVAILABILITY_LIMIT)
  async handleAvailability(
    @CurrentUser() user: UserModel,
    @Param() params: HandleParamDto,
  ): Promise<HandleAvailability> {
    return { available: await this.users.isHandleAvailable(params.handle, user.id) }
  }

  /** BS-148: the person at `/u/<handle>`. Unknown and blocked are the same 404 (`findPerson`). */
  @Get('users/handles/:handle')
  @UseGuards(ThrottlerGuard)
  @Throttle(HANDLE_LOOKUP_LIMIT)
  personByHandle(
    @CurrentUser() user: UserModel,
    @Param() params: HandleParamDto,
  ): Promise<PublicUser> {
    return this.users.findPerson({ handle: params.handle }, user.id)
  }

  /** BS-148: lets an old `/users/<id>/library` address find the person's `/u/<handle>`. */
  @Get('users/:id')
  personById(@CurrentUser() user: UserModel, @Param('id') id: string): Promise<PublicUser> {
    return this.users.findPerson({ id }, user.id)
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
