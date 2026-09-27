import {
  externalBorrowerListResponseSchema,
  externalBorrowerResponseSchema,
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
