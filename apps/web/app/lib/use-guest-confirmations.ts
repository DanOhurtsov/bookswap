'use client'

import {
  guestLoanConfirmationListResponseSchema,
  guestLoanConfirmationResponseSchema,
  type GuestLoanConfirmationListResponse,
  type GuestLoanConfirmationResponse,
} from '@bookswap/shared'
import { useApiResource, type Resource } from './use-resource'

/**
 * Stage 10 (10i.3): `GET /guest-loan-confirmations[/:id]` — owner-only ресурс запитів підтвердження
 * (окремий від `/loans/guest`: очікувані й скасовані запити читаються лише тут). Як і `useGuestLoans`,
 * хук прапора не читає — компонент, що його монтує, сам вирішує, коли (лише за `features.guestLoans`).
 */
export type GuestConfirmationsResource = Resource<GuestLoanConfirmationListResponse>
export type GuestConfirmationResource = Resource<GuestLoanConfirmationResponse>

export function useGuestConfirmations(): GuestConfirmationsResource {
  return useApiResource('/guest-loan-confirmations', guestLoanConfirmationListResponseSchema)
}

/** Чужий, неіснуючий і синтетичний запит API віддає як 404. */
export function useGuestConfirmation(confirmationId: string): GuestConfirmationResource {
  return useApiResource(
    `/guest-loan-confirmations/${encodeURIComponent(confirmationId)}`,
    guestLoanConfirmationResponseSchema,
  )
}
