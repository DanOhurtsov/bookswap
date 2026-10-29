import { publicUserSchema, type PublicUser } from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/** `GET /users/handles/:handle` — the person at `/u/<handle>`; 404 for unknown and blocked alike. */
export function fetchPersonByHandle(handle: string, signal?: AbortSignal): Promise<PublicUser> {
  return apiRequest(`/users/handles/${encodeURIComponent(handle)}`, {
    schema: publicUserSchema,
    signal,
  })
}

/** `GET /users/:id` — the same person by id, for old `/users/<id>/library` addresses. */
export function fetchPersonById(id: string, signal?: AbortSignal): Promise<PublicUser> {
  return apiRequest(`/users/${encodeURIComponent(id)}`, { schema: publicUserSchema, signal })
}
