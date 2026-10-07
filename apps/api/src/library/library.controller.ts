import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  API_ERROR_CODES,
  type BorrowedLibraryResponse,
  type CopyResponse,
  type LibraryResponse,
  type OwnBookResponse,
  type VisibleLibraryResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { AddCopyDto, LibraryQueryDto, UpdateCopyDto } from './dto/library.dto'
import { LibraryService } from './library.service'
import type { UserModel } from '../generated/prisma/models'

@Controller()
@UseGuards(SessionGuard)
export class LibraryController {
  constructor(private readonly library: LibraryService) {}

  // Статичні сегменти оголошені перед `:copyId` — інакше `/me/library/out`
  // прочитається як примірник з id «out».
  @Get('me/library')
  listOwn(@CurrentUser() user: UserModel, @Query() dto: LibraryQueryDto): Promise<LibraryResponse> {
    return this.library.listOwn(user.id, dto)
  }

  @Get('me/library/out')
  listOut(@CurrentUser() user: UserModel): Promise<LibraryResponse> {
    return this.library.listOut(user.id)
  }

  @Get('me/library/borrowed')
  listBorrowed(@CurrentUser() user: UserModel): Promise<BorrowedLibraryResponse> {
    return this.library.listBorrowed(user.id)
  }

  /**
   * Сторінка власної книги. Шлях має сегмент `copies/`, а не голий `:copyId`: одно-сегментний
   * `GET me/library/:copyId` перехопив би `GET me/library/add-search` з `AddSearchController`,
   * який реєструється пізніше за цей контролер.
   */
  @Get('me/library/copies/:copyId')
  getOwn(
    @CurrentUser() user: UserModel,
    @Param('copyId') copyId: string,
  ): Promise<OwnBookResponse> {
    return this.library.getOwn(user.id, copyId)
  }

  @Post('me/library')
  @HttpCode(HttpStatus.CREATED)
  addCopy(@CurrentUser() user: UserModel, @Body() dto: AddCopyDto): Promise<CopyResponse> {
    return this.library.addCopy(user.id, dto)
  }

  @Patch('me/library/:copyId')
  updateCopy(
    @CurrentUser() user: UserModel,
    @Param('copyId') copyId: string,
    @Body() dto: UpdateCopyDto,
  ): Promise<CopyResponse> {
    // `undefined` у Prisma означає «не чіпати», тож порожнє тіло мовчки зробило б
    // нічого й повернуло 200 — відповідь, яка бреше про виконану дію.
    const changes = definedFields(dto)

    if (Object.keys(changes).length === 0) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Не передано жодного поля для зміни',
        HttpStatus.BAD_REQUEST,
      )
    }

    return this.library.updateCopy(user.id, copyId, changes)
  }

  @Delete('me/library/:copyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCopy(@CurrentUser() user: UserModel, @Param('copyId') copyId: string): Promise<void> {
    await this.library.removeCopy(user.id, copyId)
  }

  @Post('me/library/:copyId/archive')
  @HttpCode(HttpStatus.OK)
  archiveCopy(
    @CurrentUser() user: UserModel,
    @Param('copyId') copyId: string,
  ): Promise<CopyResponse> {
    return this.library.archiveCopy(user.id, copyId)
  }

  @Post('me/library/:copyId/restore')
  @HttpCode(HttpStatus.OK)
  restoreCopy(
    @CurrentUser() user: UserModel,
    @Param('copyId') copyId: string,
  ): Promise<CopyResponse> {
    return this.library.restoreCopy(user.id, copyId)
  }

  /** §6.5 і матриця §9 — усе рішення про видимість ухвалює сервіс. */
  @Get('users/:id/library')
  listOf(
    @CurrentUser() user: UserModel,
    @Param('id') ownerId: string,
  ): Promise<VisibleLibraryResponse> {
    return this.library.listOf(user.id, ownerId)
  }
}

/** Прибирає ключі зі значенням `undefined`, лишаючи явні `null`. */
function definedFields<T extends object>(dto: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(dto).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}
