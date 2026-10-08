import {
  Body,
  Controller,
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
  isRecordAction,
  type LoanListResponse,
  type LoanResponse,
} from '@bookswap/shared'
import { CurrentUser } from '../auth/authenticated-request'
import { SessionGuard } from '../auth/session.guard'
import { ApiException } from '../common/api.exception'
import { CreateLoanDto, CreateRecordedLoanDto, LoanQueryDto, UpdateLoanDto } from './dto/loan.dto'
import { LoanService } from './loan.service'
import type { UserModel } from '../generated/prisma/models'

/**
 * §8, блок «Позичання».
 *
 * Контролер не бачить жодного статусу лоану: він приймає `action` і віддає його
 * сервісу. Це і є §5 на рівні маршрутів — прямих ендпоінтів «підтвердити» чи
 * «повернути» тут немає, бо кожен із них був би другим місцем, де живе рішення
 * про перехід.
 */
@Controller()
@UseGuards(SessionGuard)
export class LoansController {
  constructor(private readonly loans: LoanService) {}

  @Post('loans')
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: UserModel, @Body() dto: CreateLoanDto): Promise<LoanResponse> {
    return this.loans.request(user.id, dto)
  }

  /** Stage 10 (10e, D6): власник записує вже передану книжку; позичальник підтверджує через `PATCH`. */
  @Post('loans/recorded')
  @HttpCode(HttpStatus.CREATED)
  createRecorded(
    @CurrentUser() user: UserModel,
    @Body() dto: CreateRecordedLoanDto,
  ): Promise<LoanResponse> {
    return this.loans.recordExisting(user.id, dto)
  }

  @Get('loans')
  list(@CurrentUser() user: UserModel, @Query() dto: LoanQueryDto): Promise<LoanListResponse> {
    return this.loans.list(user.id, dto)
  }

  @Get('loans/:id')
  get(@CurrentUser() user: UserModel, @Param('id') loanId: string): Promise<LoanResponse> {
    return this.loans.get(user.id, loanId)
  }

  @Patch('loans/:id')
  update(
    @CurrentUser() user: UserModel,
    @Param('id') loanId: string,
    @Body() dto: UpdateLoanDto,
  ): Promise<LoanResponse> {
    // Правило про ПАРУ полів: `dueAt` має сенс лише разом із `approve`, бо термін
    // повернення встановлює власник, погоджуючи запит. `class-validator` таких
    // залежностей не виражає — рівно як «оновити хоч щось» у `PATCH /me`, — тож
    // перевірка стоїть тут. Мовчазне ігнорування було б гіршим: клієнт вважав би,
    // що термін збережено.
    if (dto.dueAt !== undefined && dto.action !== 'approve' && dto.action !== 'amend_record') {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Термін повернення встановлюється під час підтвердження запиту або виправлення запису',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Q23: явний `null` («прибрати строк») дозволений лише для `amend_record`; відсутнє поле — «не змінювати».
    if (dto.dueAt === null && dto.action !== 'amend_record') {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Прибрати строк повернення можна лише дією amend_record',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Stage 10 (10e): `handedAt` — лише з `amend_record`, який без жодної з двох дат беззмістовний;
    // `note` із діями запису не поєднується (`responseNote` — поле request-flow).
    if (dto.handedAt !== undefined && dto.action !== 'amend_record') {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Дату передачі можна вказати лише разом із дією amend_record',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (dto.action === 'amend_record' && dto.handedAt === undefined && dto.dueAt === undefined) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Для amend_record потрібна нова дата передачі або строк повернення',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (dto.note !== undefined && isRecordAction(dto.action)) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Примітка не поєднується з діями запису',
        HttpStatus.BAD_REQUEST,
      )
    }

    // Stage 10 (10d): `effectiveAt` — лише з `recover`, і `recover` не приймає `note` (він не
    // переписує `responseNote` чи інші минулі факти). Той самий клас правил про пару полів.
    if (dto.effectiveAt !== undefined && dto.action !== 'recover') {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Дату знахідки можна вказати лише разом із дією recover',
        HttpStatus.BAD_REQUEST,
      )
    }

    if (dto.action === 'recover' && dto.note !== undefined) {
      throw new ApiException(
        API_ERROR_CODES.VALIDATION_ERROR,
        'Примітка не поєднується з дією recover',
        HttpStatus.BAD_REQUEST,
      )
    }

    return this.loans.apply(user.id, loanId, dto)
  }
}
