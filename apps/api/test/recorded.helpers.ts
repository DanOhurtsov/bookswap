import request from 'supertest'
import { loanResponseSchema, type Loan } from '@bookswap/shared'
import { url, type Account } from './loan.helpers'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/** День UTC зі зсувом — рівно так, як його рахує сервер (`toISOString().slice(0, 10)`). */
export const utcDay = (offsetDays = 0): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

/** Stage 10 (10e): `POST /loans/recorded` — усю відповідь віддає тест. */
export function recordLoan(
  app: INestApplication<App>,
  owner: Account,
  body: Record<string, unknown>,
): request.Test {
  return request(app.getHttpServer())
    .post(url('/loans/recorded'))
    .set('Cookie', owner.cookie)
    .send(body)
}

/** Успішний запис із типовими датами; повертає розібраний `Loan`. */
export async function recordedLoan(
  app: INestApplication<App>,
  owner: Account,
  borrower: Account,
  copyId: string,
  extra: Record<string, unknown> = {},
): Promise<Loan> {
  const response = await recordLoan(app, owner, {
    copyId,
    borrowerId: borrower.id,
    handedAt: utcDay(-10),
    ...extra,
  }).expect(201)

  return loanResponseSchema.parse(response.body).loan
}
