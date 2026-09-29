import {
  answerGuestResponseResponseSchema,
  guestLoanConfirmationResponseSchema,
  issueGuestConfirmationLinkResponseSchema,
  requestGuestCodeResponseSchema,
  resolveGuestResponseResponseSchema,
  verifyGuestCodeResponseSchema,
  type AnswerGuestResponseRequest,
  type CreateGuestLoanConfirmationRequest,
  type IssueGuestConfirmationLinkRequest,
  type RequestGuestCodeRequest,
  type UpdateGuestLoanConfirmationRequest,
  type VerifyGuestCodeRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

// --- Owner (сесія власника, `/guest-loan-confirmations`) -----------------------------------------

/** `POST /guest-loan-confirmations` — те саме тіло, що й ручний `POST /loans/guest`. */
export const createGuestConfirmation = (body: CreateGuestLoanConfirmationRequest) =>
  apiRequest('/guest-loan-confirmations', {
    method: 'POST',
    body,
    schema: guestLoanConfirmationResponseSchema,
  })

/** `PATCH /guest-loan-confirmations/:id { action }` — cancel_handover / record_owner_statement. */
export const actOnGuestConfirmation = (id: string, body: UpdateGuestLoanConfirmationRequest) =>
  apiRequest(`/guest-loan-confirmations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: guestLoanConfirmationResponseSchema,
  })

/** `POST /guest-loan-confirmations/:id/link` — видача (або повторна видача) поточного посилання. */
export const issueGuestConfirmationLink = (id: string, body: IssueGuestConfirmationLinkRequest) =>
  apiRequest(`/guest-loan-confirmations/${encodeURIComponent(id)}/link`, {
    method: 'POST',
    body,
    schema: issueGuestConfirmationLinkResponseSchema,
  })

// --- Публічний гість (без сесії, `/guest-loan-responses/*`; токен — завжди в тілі) -----------------

export const resolveGuestLink = (token: string) =>
  apiRequest('/guest-loan-responses/resolve', {
    method: 'POST',
    body: { token },
    schema: resolveGuestResponseResponseSchema,
  })

export const requestGuestCode = (body: RequestGuestCodeRequest) =>
  apiRequest('/guest-loan-responses/code', {
    method: 'POST',
    body,
    schema: requestGuestCodeResponseSchema,
  })

export const verifyGuestCode = (body: VerifyGuestCodeRequest) =>
  apiRequest('/guest-loan-responses/verify', {
    method: 'POST',
    body,
    schema: verifyGuestCodeResponseSchema,
  })

export const answerGuestLoan = (body: AnswerGuestResponseRequest) =>
  apiRequest('/guest-loan-responses/answer', {
    method: 'POST',
    body,
    schema: answerGuestResponseResponseSchema,
  })
