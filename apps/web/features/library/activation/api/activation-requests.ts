import { activationResponseSchema, type ActivationResponse } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * The browser's half of the same read. Same transport as every other request
 * in this application (§3.9: no second fetch layer under TanStack Query) and
 * the same shared schema as the server half, so both can only ever produce a
 * value the contract allows.
 */
export function fetchActivation(signal?: AbortSignal): Promise<ActivationResponse> {
  return apiRequest('/me/activation', {
    schema: activationResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })
}
