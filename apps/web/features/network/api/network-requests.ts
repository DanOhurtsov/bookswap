import {
  acceptInvitationResponseSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
  resolveInvitationResponseSchema,
  workHoldersResponseSchema,
  type CreateInvitationRequest,
} from '@bookswap/shared'
import { apiRequest, apiRequestWithRedirect } from '@/app/lib/api'
import { inviteLinkFor } from '../model/invite-token'

export const createInvitation = (body: CreateInvitationRequest) =>
  apiRequest('/invitations', {
    method: 'POST',
    body,
    schema: createInvitationResponseSchema,
  })

/**
 * BS-148: a fresh link invitation, as the address to share. A link invitation always carries its
 * token — only an email one does not — so a missing token is a broken answer, not an empty one.
 */
export async function createInviteLink(origin: string): Promise<string> {
  const { token } = await createInvitation({ kind: 'LINK' })

  if (token === undefined) throw new Error('Сервер не повернув посилання-запрошення.')

  return inviteLinkFor(token, origin)
}

export const listInvitations = (signal?: AbortSignal) =>
  apiRequest('/invitations', { schema: invitationListResponseSchema, signal })

export const revokeInvitation = (id: string) =>
  apiRequest(`/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const resolveInvitation = (token: string) =>
  apiRequest('/invitations/resolve', {
    method: 'POST',
    body: { token },
    schema: resolveInvitationResponseSchema,
  })

export const acceptInvitation = (token: string) =>
  apiRequest('/invitations/accept', {
    method: 'POST',
    body: { token },
    schema: acceptInvitationResponseSchema,
  })

export const fetchWorkHolders = (workId: string, signal?: AbortSignal) =>
  apiRequestWithRedirect(`/works/${encodeURIComponent(workId)}/holders`, {
    schema: workHoldersResponseSchema,
    signal,
  })

export const requestLoan = (copyId: string, body: Record<string, unknown>) =>
  apiRequest('/loans', { method: 'POST', body: { copyId, ...body } })
