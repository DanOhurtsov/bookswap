import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHmac, randomBytes } from 'node:crypto'

/**
 * `Invitation.recipientEmailHash`: HMAC-SHA-256 від нормалізованої адреси.
 *
 * Простий SHA-256 адреси тут не годиться: простір адрес малий і словниковий, тож
 * дамп таблиці дозволяв би перевірити, кого запрошували. Ключ живе лише в
 * оточенні (`INVITE_EMAIL_HMAC_SECRET`, обов'язковий у production) і однаковий на
 * всіх інстансах — тому ліміти на адресу, що рахуються в БД, лишаються спільними.
 *
 * Поза production без ключа береться випадковий ключ процесу: непередбачуваний,
 * але ліміти на адресу не переживають рестарт (як і in-memory throttler).
 */
@Injectable()
export class InviteEmailHasher {
  private readonly secret: string

  constructor(config: ConfigService) {
    const configured = config.get<string>('INVITE_EMAIL_HMAC_SECRET')

    if (configured === undefined) {
      new Logger(InviteEmailHasher.name).warn(
        'INVITE_EMAIL_HMAC_SECRET не задано: використано випадковий ключ процесу (лише не-production)',
      )
    }

    this.secret = configured ?? randomBytes(32).toString('hex')
  }

  hash(email: string): string {
    return createHmac('sha256', this.secret)
      .update(`bookswap-invite-email:v2:${email.trim().toLowerCase()}`)
      .digest('hex')
  }
}
