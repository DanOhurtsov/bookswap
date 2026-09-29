import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'

/**
 * Stage 10 (10i.2): HMAC-примітиви гостьової перевірки email.
 *
 * Що зберігається в БД: не адреса й не нікнейм гостя, не код — лише HMAC. `challengeMac` зв'язує виклик
 * з КОНКРЕТНИМ підтвердженням (а отже посиланням, позикою й контактом), адресою B і нікнеймом; `codeHash`
 * зв'язує код із цим викликом. Простий SHA-256 шестизначного коду тут не годиться (10^6 значень
 * перебираються миттєво з дампа) — потрібен ключ поза БД.
 *
 * Ключ — `INVITE_EMAIL_HMAC_SECRET` (той самий секрет, що для `InviteEmailHasher`), але з ВЛАСНИМИ
 * префіксами доменів: жоден HMAC цього класу не збігається з жодним HMAC запрошень. Нового env-ключа
 * немає (кожен новий ключ — ще один спосіб зламати прод одруківкою). Поза production без ключа береться
 * випадковий ключ процесу: після рестарту чинні коди/докази стають недійсними — гість просить новий код.
 */
@Injectable()
export class GuestConfirmationSecrets {
  private readonly secret: string

  constructor(config: ConfigService) {
    this.secret = config.get<string>('INVITE_EMAIL_HMAC_SECRET') ?? randomBytes(32).toString('hex')
  }

  /** Пов'язує виклик з підтвердженням, нормалізованою адресою й нікнеймом (без збереження жодного з них). */
  challengeMac(confirmationId: string, email: string, nickname: string): string {
    return this.mac(
      'bookswap-guest-challenge:v1',
      confirmationId,
      email.trim().toLowerCase(),
      nickname.trim(),
    )
  }

  /** Пов'язує шестизначний код із викликом. */
  codeHash(confirmationId: string, challengeMac: string, code: string): string {
    return this.mac('bookswap-guest-code:v1', confirmationId, challengeMac, code)
  }

  /** Рівномірний шестизначний код із провідними нулями; `randomInt` — CSPRNG без зсуву. */
  generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0')
  }

  /** Незалежний від коду ідентифікатор видачі (128 біт): відрізняє дві видачі з однаковими шістьма цифрами. */
  generateNonce(): string {
    return randomBytes(16).toString('hex')
  }

  /** Порівняння за сталий час; різна довжина — просто «ні». */
  equal(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)

    return a.length === b.length && timingSafeEqual(a, b)
  }

  private mac(domain: string, ...parts: string[]): string {
    // Довжини у складі повідомлення: `("ab","c")` і `("a","bc")` не мають давати той самий HMAC.
    const message = parts.map((part) => `${String(part.length)}:${part}`).join('|')

    return createHmac('sha256', this.secret).update(`${domain}|${message}`).digest('hex')
  }
}
