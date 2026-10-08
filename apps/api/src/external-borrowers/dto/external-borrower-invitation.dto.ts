import { Transform } from 'class-transformer'
import { IsEmail, Matches, MaxLength } from 'class-validator'
import { GUEST_INVITATION_EMAIL_DOMAIN, PROFILE_LIMITS } from '@bookswap/shared'

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value

const GUEST_DOMAIN_PATTERN = new RegExp(
  `@${GUEST_INVITATION_EMAIL_DOMAIN.replace(/\./g, '\\.')}$`,
  'i',
)

/**
 * `POST /me/external-borrowers/:id/invitation` (Stage 10, 10g). D2: лише
 * зарезервований синтетичний тестовий домен — недомен відхиляється тут, до будь-якого
 * запиту до БД чи спроби відправки (§7 execution plan лишається відкритим release
 * blocker; це другий, незалежний рубіж, а не зняття блокера).
 */
export class CreateExternalBorrowerInvitationDto {
  @Transform(normalizeEmail)
  @IsEmail({}, { message: 'Некоректна email-адреса' })
  @MaxLength(PROFILE_LIMITS.emailMax)
  @Matches(GUEST_DOMAIN_PATTERN, {
    message: `Лише синтетичні адреси домену ${GUEST_INVITATION_EMAIL_DOMAIN} (D2 — реальні дані заборонені)`,
  })
  email!: string
}
