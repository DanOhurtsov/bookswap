import {
  acceptInvitationResponseSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
  resolveInvitationResponseSchema,
  workHoldersResponseSchema,
  type CreateInvitationRequest,
} from '@bookswap/shared'
import { apiRequest, apiRequestWithRedirect } from '@/app/lib/api'

export const createInvitation = (body: CreateInvitationRequest) =>
  apiRequest('/invitations', {
    method: 'POST',
    body,
    schema: createInvitationResponseSchema,
  })

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
