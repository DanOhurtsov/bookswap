import { ConfigService } from '@nestjs/config'
import { GuestConfirmationSecrets } from './guest-confirmation-secrets'

/** Stage 10, 10i.2: HMAC-примітиви. Лише синтетичні дані (D2). */

const config = (secret: string | undefined): ConfigService =>
  ({ get: () => secret }) as unknown as ConfigService

describe('GuestConfirmationSecrets', () => {
  const secrets = new GuestConfirmationSecrets(config('k'.repeat(32)))

  it('challengeMac прив’язаний до підтвердження, адреси й нікнейма; нормалізує адресу й нікнейм', () => {
    const base = secrets.challengeMac('gc1', 'a@guest.invalid', 'Гість')

    expect(secrets.challengeMac('gc1', '  A@Guest.Invalid ', ' Гість ')).toBe(base)
    expect(secrets.challengeMac('gc2', 'a@guest.invalid', 'Гість')).not.toBe(base)
    expect(secrets.challengeMac('gc1', 'b@guest.invalid', 'Гість')).not.toBe(base)
    expect(secrets.challengeMac('gc1', 'a@guest.invalid', 'Інший')).not.toBe(base)
  })

  it('межі полів однозначні: («ab»,«c») ≠ («a»,«bc»)', () => {
    expect(secrets.challengeMac('gc', 'ab@guest.invalid', 'c')).not.toBe(
      secrets.challengeMac('gc', 'a@guest.invalid', 'bc'),
    )
  })

  it('codeHash прив’язаний до виклику, підтвердження й самого коду; домени розділені', () => {
    const mac = secrets.challengeMac('gc1', 'a@guest.invalid', 'Гість')
    const hash = secrets.codeHash('gc1', mac, '123456')

    expect(secrets.codeHash('gc1', mac, '123457')).not.toBe(hash)
    expect(secrets.codeHash('gc2', mac, '123456')).not.toBe(hash)
    expect(
      secrets.codeHash('gc1', secrets.challengeMac('gc1', 'b@guest.invalid', 'Гість'), '123456'),
    ).not.toBe(hash)
    // Ні код, ні адреса не читаються з гешу: лише hex-дайджест.
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('123456')
  })

  it('інший ключ дає інші значення (дамп БД без ключа не дозволяє перебрати код)', () => {
    const other = new GuestConfirmationSecrets(config('z'.repeat(32)))

    expect(other.codeHash('gc1', 'm', '123456')).not.toBe(secrets.codeHash('gc1', 'm', '123456'))
  })

  it('без ключа береться випадковий ключ процесу (значення не збігаються між екземплярами)', () => {
    const one = new GuestConfirmationSecrets(config(undefined))
    const two = new GuestConfirmationSecrets(config(undefined))

    expect(one.codeHash('gc', 'm', '000000')).not.toBe(two.codeHash('gc', 'm', '000000'))
  })

  it('generateCode: завжди рівно шість цифр, включно з провідними нулями', () => {
    const seen = new Set<string>()

    for (let i = 0; i < 2000; i += 1) {
      const code = secrets.generateCode()

      expect(code).toMatch(/^\d{6}$/)
      seen.add(code)
    }

    expect(seen.size).toBeGreaterThan(1900)
  })

  it('generateNonce: 128 біт hex, кожен виклик різний (не залежить від коду)', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => secrets.generateNonce()))

    expect(nonces.size).toBe(200)

    for (const nonce of nonces) expect(nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('equal: порівняння за значенням, різна довжина — false', () => {
    expect(secrets.equal('abc', 'abc')).toBe(true)
    expect(secrets.equal('abc', 'abd')).toBe(false)
    expect(secrets.equal('abc', 'abcd')).toBe(false)
    expect(secrets.equal('', '')).toBe(true)
  })
})
