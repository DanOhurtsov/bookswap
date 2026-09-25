import { z } from 'zod'
import { friendRelationSchema } from '../domain/friendship'
import { emailSchema, publicUserSchema } from './user'

/**
 * Етап 9: запрошення. Рішення D1–D6 — у `docs/plan/stage-9-network-activation.md`.
 *
 * Токен повертається один раз, при створенні посилання. Далі він існує лише в
 * посиланні, яким поділився запрошувач: у БД лежить SHA-256.
 */

export const INVITATION_TTL_DAYS = 14
export const INVITATION_LINK_MAX_USES = 10
export const INVITATION_EMAIL_MAX_USES = 1
export const INVITATION_TOKEN_MAX = 128

export const INVITATION_KINDS = ['LINK', 'EMAIL'] as const
export const invitationKindSchema = z.enum(INVITATION_KINDS)
export type InvitationKind = z.infer<typeof invitationKindSchema>

export const INVITATION_STATUSES = ['ACTIVE', 'EXPIRED', 'REVOKED', 'EXHAUSTED'] as const
export const invitationStatusSchema = z.enum(INVITATION_STATUSES)
export type InvitationStatus = z.infer<typeof invitationStatusSchema>

export const invitationSchema = z.object({
  id: z.string(),
  kind: invitationKindSchema,
  status: invitationStatusSchema,
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  acceptedCount: z.number().int().nonnegative(),
  maxUses: z.number().int().positive(),
})

export type Invitation = z.infer<typeof invitationSchema>

export const createInvitationRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LINK') }),
  z.object({ kind: z.literal('EMAIL'), email: emailSchema }),
])

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>

/** `token` — лише для `LINK`, і лише в цій відповіді. */
export const createInvitationResponseSchema = z.object({
  invitation: invitationSchema,
  token: z.string().optional(),
})

export type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>

export const invitationListResponseSchema = z.object({
  invitations: z.array(invitationSchema),
})

export type InvitationListResponse = z.infer<typeof invitationListResponseSchema>

export const invitationTokenRequestSchema = z.object({
  token: z.string().trim().min(1).max(INVITATION_TOKEN_MAX),
})

export type InvitationTokenRequest = z.infer<typeof invitationTokenRequestSchema>

/** Стан токена з погляду того, хто його відкрив. */
export const INVITATION_RESOLVE_STATES = [
  'ACTIVE',
  'ALREADY_ACCEPTED',
  'EXPIRED',
  'REVOKED',
  'EXHAUSTED',
  'SELF',
] as const
export const invitationResolveStateSchema = z.enum(INVITATION_RESOLVE_STATES)
export type InvitationResolveState = z.infer<typeof invitationResolveStateSchema>

export const resolveInvitationResponseSchema = z.object({
  state: invitationResolveStateSchema,
  inviter: publicUserSchema,
  relation: friendRelationSchema,
})

export type ResolveInvitationResponse = z.infer<typeof resolveInvitationResponseSchema>

export const acceptInvitationResponseSchema = z.object({
  relation: friendRelationSchema,
  inviter: publicUserSchema,
})

export type AcceptInvitationResponse = z.infer<typeof acceptInvitationResponseSchema>
