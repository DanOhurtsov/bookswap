import { Controller, Get, UseGuards } from '@nestjs/common'
import type { ActivationResponse } from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ActivationService } from './activation.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 8h-1, R11 and §4: `GET /api/v1/me/activation`.
 *
 * Its own controller rather than another method on `LibraryController`: that
 * one is about copies — listing, adding, editing, deleting — and this is about
 * one number describing the owner. They share a module because they share a
 * domain, not a resource.
 *
 * No input DTO, because there is no input: no body, no query, no route param.
 * The only thing the request carries is the session, and `SessionGuard` is what
 * reads it — an unauthenticated call is a 401 before this class is reached
 * (§6.3: the authorization decision is explicit, and it is this guard).
 *
 * The answer is always the caller's own progress. `ownerId` comes from the
 * session and never from the request, so there is no id to authorize and no way
 * to ask about somebody else's shelf.
 *
 * On Swagger: §6.3 of CONVENTIONS.md asks for `@ApiOperation`/`@ApiResponse`,
 * but `@nestjs/swagger` is not a dependency of this application and no
 * controller in it carries those decorators — without `SwaggerModule.setup()`
 * they are metadata nobody reads. Wiring a document (and the endpoint that
 * serves it) is not part of 8h-1, so the operation and its response are
 * described here and typed by `ActivationResponse`, whose shape the shared
 * contract enforces.
 */
@Controller()
@UseGuards(SessionGuard)
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Get('me/activation')
  progress(@CurrentUser() user: UserModel): Promise<ActivationResponse> {
    return this.activation.progressOf(user.id)
  }
}
