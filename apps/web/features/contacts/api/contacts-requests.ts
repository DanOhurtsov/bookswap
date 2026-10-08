import {
  externalBorrowerInvitationResponseSchema,
  externalBorrowerListResponseSchema,
  externalBorrowerResponseSchema,
  type CreateExternalBorrowerInvitationRequest,
  type CreateExternalBorrowerRequest,
  type UpdateExternalBorrowerRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

export const listContacts = (signal?: AbortSignal) =>
  apiRequest('/me/external-borrowers', { schema: externalBorrowerListResponseSchema, signal })

export const createContact = (body: CreateExternalBorrowerRequest) =>
  apiRequest('/me/external-borrowers', {
    method: 'POST',
    body,
    schema: externalBorrowerResponseSchema,
  })

export const renameContact = (id: string, body: UpdateExternalBorrowerRequest) =>
  apiRequest(`/me/external-borrowers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body,
    schema: externalBorrowerResponseSchema,
  })

/**
 * Stage 10 (10f.3, Q3d): дострокова чистка. Сервер відмовляє (409), доки є активна позика чи
 * незакрита втрата контакту — фронт лише передає повідомлення сервера, а не вгадує причину сам.
 */
export const deleteContact = (id: string) =>
  apiRequest(`/me/external-borrowers/${encodeURIComponent(id)}`, { method: 'DELETE' })

/**
 * Stage 10 (10g, D2): запрошення гостя. Відповідь не містить email — сервер його
 * ніколи не відлунює (Q4).
 */
export const sendContactInvitation = (id: string, body: CreateExternalBorrowerInvitationRequest) =>
  apiRequest(`/me/external-borrowers/${encodeURIComponent(id)}/invitation`, {
    method: 'POST',
    body,
    schema: externalBorrowerInvitationResponseSchema,
  })
