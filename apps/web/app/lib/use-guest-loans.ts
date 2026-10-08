'use client'

import {
  guestLoanListResponseSchema,
  guestLoanResponseSchema,
  type GuestLoanListResponse,
  type GuestLoanResponse,
} from '@bookswap/shared'
import { useApiResource, type Resource } from './use-resource'

/**
 * Stage 10 (10f.3): `GET /loans/guest[/:id]` — owner-only. Ті самі три стани, що й `useLoans`/`useLoan`
 * (`use-loans.ts`): «ще вантажу» і «порожньо» — різні речі. Мовтується лише коли сервер повідомив
 * `features.guestLoans === true` — компонент, що монтує цей хук, сам вирішує, коли це робити
 * (сторінка `/loans/guest` і форма створення в бібліотеці), тож хук жодного прапора не читає сам.
 */
export type GuestLoansResource = Resource<GuestLoanListResponse>
export type GuestLoanResource = Resource<GuestLoanResponse>

export function useGuestLoans(): GuestLoansResource {
  return useApiResource('/loans/guest', guestLoanListResponseSchema)
}

/** Чужа, неіснуюча й синтетична позика API віддає як 404 — фронту нема що тут перевіряти. */
export function useGuestLoan(loanId: string): GuestLoanResource {
  return useApiResource(`/loans/guest/${encodeURIComponent(loanId)}`, guestLoanResponseSchema)
}
