import {
  guestLoanResponseSchema,
  type CreateGuestLoanRequest,
  type UpdateGuestLoanRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/** Stage 10 (10f.3): `POST /loans/guest` — власник записує книжку, віддану людині без акаунта. */
export const createGuestLoan = (body: CreateGuestLoanRequest) =>
  apiRequest('/loans/guest', { method: 'POST', body, schema: guestLoanResponseSchema })

/** `PATCH /loans/guest/:id { action }` — return/mark_lost/recover/close_loss. */
export const actOnGuestLoan = (loanId: string, body: UpdateGuestLoanRequest) =>
  apiRequest(`/loans/guest/${encodeURIComponent(loanId)}`, {
    method: 'PATCH',
    body,
    schema: guestLoanResponseSchema,
  })
