import { acceptedResponseSchema, meSchema, type UpdateProfileRequest } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/** The answer is the whole saved profile, the same projection the session holds. */
export const updateProfile = (body: UpdateProfileRequest) =>
  apiRequest('/me', { method: 'PATCH', body, schema: meSchema })

export const resendEmailVerification = () =>
  apiRequest('/auth/email-verification', { method: 'POST', schema: acceptedResponseSchema })
