import {
  copyResponseSchema,
  ownBookResponseSchema,
  type CopyResponse,
  type OwnBookResponse,
  type UpdateCopyRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/** `GET /me/library/copies/:id` — one copy of the signed-in owner, 404 for anyone else's. */
export function fetchOwnBook(entryId: string, signal?: AbortSignal): Promise<OwnBookResponse> {
  return apiRequest(`/me/library/copies/${encodeURIComponent(entryId)}`, {
    schema: ownBookResponseSchema,
    signal,
  })
}

/** `PATCH /me/library/:id` with the note only: the one private field this page edits. */
export function saveOwnBookNote(entryId: string, note: string | null): Promise<CopyResponse> {
  const body: UpdateCopyRequest = { note }

  return apiRequest(`/me/library/${encodeURIComponent(entryId)}`, {
    method: 'PATCH',
    body,
    schema: copyResponseSchema,
  })
}
