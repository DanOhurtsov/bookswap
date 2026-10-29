import {
  acceptedResponseSchema,
  handleAvailabilitySchema,
  meSchema,
  type UpdateProfileRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/** The answer is the whole saved profile, the same projection the session holds. */
export const updateProfile = (body: UpdateProfileRequest, signal?: AbortSignal) =>
  apiRequest('/me', { method: 'PATCH', body, schema: meSchema, signal })

export const resendEmailVerification = () =>
  apiRequest('/auth/email-verification', { method: 'POST', schema: acceptedResponseSchema })

/** BS-148: whether the signed-in user may take this nickname; their own current one is free. */
export const checkHandleAvailability = (handle: string, signal?: AbortSignal) =>
  apiRequest(`/users/handles/${encodeURIComponent(handle)}/availability`, {
    schema: handleAvailabilitySchema,
    signal,
  })

/** BS-148: the photo itself is the body; the answer is the profile with its new address. */
export const uploadAvatar = (photo: Blob) =>
  apiRequest('/me/avatar', { method: 'POST', body: photo, schema: meSchema })

export const removeAvatar = () => apiRequest('/me/avatar', { method: 'DELETE', schema: meSchema })
