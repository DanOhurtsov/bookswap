import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  API_ERROR_CODES,
  type GuestLoanListResponse,
  type GuestLoanResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { GuestLoansEnabledGuard } from '../common/guest-loans-enabled.guard'
import { CreateGuestLoanDto, UpdateGuestLoanDto } from './dto/guest-loan.dto'
import { GuestLoanService } from './guest-loan.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * Stage 10 (10f.3, §1 read-only рев'ю перед реалізацією): окремий контролер, а не нові методи в
 * `LoansController`.
 *
 * Причина — не стиль, а механіка NestJS: guard-и виконуються в порядку клас → метод, і
 * `LoansController` уже має клас-рівневий `SessionGuard`. Додавши сюди метод із метод-рівневим
 * `GuestLoansEnabledGuard`, ми отримали б `SessionGuard` (клас) **першим** — саме те, чого T9
 * (`§7.3`) прямо забороняє: вимкнена функція не має чіпати сесію взагалі. Єдиний спосіб мати
 * `GuestLoansEnabledGuard → SessionGuard` — обидва клас-рівневі, в окремому контролері (той самий
 * прийом, що вже в `ExternalBorrowersController`).
 *
 * Реєстрований `PATCH /loans/:id` (`LoansController`) лишається структурно недоторканим: тип
 * позики не потрібно розпізнавати «під локом» — сам URL визначає диспетчер ще до будь-якого guard'а
 * чи запиту до БД. `LoansController.runTransition`'s лок-запит і далі виключає
 * `origin = RECORDED_GUEST` (`loan.service.ts:600-608`) — друга, незалежна лінія захисту.
 *
 * Реєструється в `LoansModule` **перед** `LoansController` (порядок масиву `controllers`, не
 * рішення рантайму): без цього `GET /loans/guest` (статичний сегмент) міг би загубитися за
 * `GET /loans/:id` (параметр) того самого рівня вкладеності — Express матчить перший зареєстрований
 * шаблон. `PATCH/GET /loans/guest/:id` (три сегменти) такого конфлікту не має в принципі.
 */
@Controller()
@UseGuards(GuestLoansEnabledGuard, SessionGuard)
export class GuestLoansController {
  constructor(private readonly guestLoans: GuestLoanService) {}

  @Post('loans/guest')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: UserModel,
    @Body() dto: CreateGuestLoanDto,
  ): Promise<GuestLoanResponse> {
    return this.guestLoans.create(user.id, dto)
  }

  @Get('loans/guest')
  list(@CurrentUser() user: UserModel): Promise<GuestLoanListResponse> {
    return this.guestLoans.list(user.id)
  }

  @Get('loans/guest/:id')
  get(@CurrentUser() user: UserModel, @Param('id') id: string): Promise<GuestLoanResponse> {
    return this.guestLoans.get(user.id, id)
  }

  @Patch('loans/guest/:id')
  update(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() dto: UpdateGuestLoanDto,
  ): Promise<GuestLoanResponse> {
    // Те саме правило про пару полів, що в `LoansController.update`: `class-validator` не виражає
    // «поле дозволене лише разом із конкретним значенням іншого поля».
    if (dto.effectiveAt !== undefined && dto.action !== 'recover') {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Дату знахідки можна вказати лише разом із дією recover',
        HttpStatus.BAD_REQUEST,
      )
    }

    return this.guestLoans.apply(user.id, id, dto)
  }
}
