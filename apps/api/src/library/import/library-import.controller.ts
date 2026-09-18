import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import type { LibraryImportDraftResponse } from '@bookswap/shared'
import { CurrentUser } from '../../auth/authenticated-request'
import { SessionGuard } from '../../auth/session.guard'
import {
  LIBRARY_IMPORT_PATCH_RATE_LIMIT,
  LIBRARY_IMPORT_PREVIEW_RATE_LIMIT,
  LIBRARY_IMPORT_RATE_WINDOW_MS,
} from '../../common/rate-limit.config'
import {
  LibraryImportPreviewDto,
  LibraryImportRowParamsDto,
  LibraryImportRowPatchDto,
} from './dto/library-import.dto'
import { LibraryImportService } from './library-import.service'
import type { UserModel } from '../../generated/prisma/models'

/**
 * Stage 8f-2, §4: the three draft endpoints of a CSV import.
 *
 * Authenticated throughout, and scoped to the owner inside the service: a
 * foreign import id and one that never existed answer exactly the same 404, so
 * the endpoint cannot be used to learn whether somebody else has an import.
 *
 * Both write paths carry a throttle of their own because both can reach an
 * external provider: a preview once per file, a row PATCH once per retry.
 */
@Controller()
@UseGuards(SessionGuard)
export class LibraryImportController {
  constructor(private readonly imports: LibraryImportService) {}

  @Post('me/library/imports/preview')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    import: { limit: LIBRARY_IMPORT_PREVIEW_RATE_LIMIT, ttl: LIBRARY_IMPORT_RATE_WINDOW_MS },
  })
  preview(
    @CurrentUser() user: UserModel,
    @Body() dto: LibraryImportPreviewDto,
  ): Promise<LibraryImportDraftResponse> {
    return this.imports.preview(user.id, dto.contentBase64)
  }

  @Get('me/library/imports/:id')
  getDraft(
    @CurrentUser() user: UserModel,
    @Param('id') importId: string,
  ): Promise<LibraryImportDraftResponse> {
    return this.imports.getDraft(user.id, importId)
  }

  @Patch('me/library/imports/:id/rows/:rowNumber')
  @UseGuards(ThrottlerGuard)
  @Throttle({
    import: { limit: LIBRARY_IMPORT_PATCH_RATE_LIMIT, ttl: LIBRARY_IMPORT_RATE_WINDOW_MS },
  })
  patchRow(
    @CurrentUser() user: UserModel,
    @Param() params: LibraryImportRowParamsDto,
    @Body() dto: LibraryImportRowPatchDto,
  ): Promise<LibraryImportDraftResponse> {
    return this.imports.patchRow({
      ownerId: user.id,
      importId: params.id,
      rowNumber: params.rowNumber,
      request: toPatchRequest(dto),
    })
  }
}

/** The DTO already proved the shape; this is the discriminated value the service takes. */
function toPatchRequest(
  dto: LibraryImportRowPatchDto,
): Parameters<LibraryImportService['patchRow']>[0]['request'] {
  const expectedRowVersion = dto.expectedRowVersion

  if (dto.action === 'EDIT') {
    return { action: 'EDIT', expectedRowVersion, cells: dto.cells ?? {} }
  }

  if (dto.action === 'CHOOSE') {
    return { action: 'CHOOSE', expectedRowVersion, workId: dto.workId ?? null }
  }

  return { action: dto.action, expectedRowVersion }
}
