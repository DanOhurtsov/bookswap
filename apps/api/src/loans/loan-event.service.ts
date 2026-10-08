import { Injectable } from '@nestjs/common'
import type { PrismaService } from '../prisma/prisma.service'
import { LOAN_EVENT_PAYLOAD_SCHEMA, type NewLoanEvent } from './loan-event.types'

/**
 * Stage 10 (T4): єдине місце, де пишуться `LoanEvent`.
 *
 * Append-only на рівні коду: тут є лише `record`, а `update`/`delete`/`upsert` для `LoanEvent` не
 * існує ніде в `src` (це перевіряє `loan-event.append-only.spec.ts`). Тригера в БД немає свідомо
 * (R7). Метод завжди приймає клієнт **транзакції** переходу: подія й зміна стану комітяться або
 * відкочуються разом, тож відкритої «події без переходу» чи «переходу без події» не буває.
 */
@Injectable()
export class LoanEventService {
  async record(tx: Pick<PrismaService, 'loanEvent'>, event: NewLoanEvent): Promise<void> {
    const payload = LOAN_EVENT_PAYLOAD_SCHEMA[event.type].parse(event.payload ?? {})

    await tx.loanEvent.create({
      data: {
        loanId: event.loanId,
        type: event.type,
        actorId: event.actorId,
        effectiveAt: event.effectiveAt ?? null,
        payload,
      },
    })
  }
}
