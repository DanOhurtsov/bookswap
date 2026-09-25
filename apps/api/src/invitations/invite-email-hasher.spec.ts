import { createHash } from 'node:crypto'
import type { ConfigService } from '@nestjs/config'
import { InviteEmailHasher } from './invite-email-hasher'

const config = (secret?: string): ConfigService =>
  ({ get: () => secret }) as unknown as ConfigService

const SECRET_A = 'a'.repeat(40)
const SECRET_B = 'b'.repeat(40)

describe('InviteEmailHasher', () => {
  it('is deterministic for one secret — so limits agree across instances', () => {
    expect(new InviteEmailHasher(config(SECRET_A)).hash('x@example.com')).toBe(
      new InviteEmailHasher(config(SECRET_A)).hash('x@example.com'),
    )
  })

  it('is not a plain SHA-256 of the address, with or without the domain prefix', () => {
    const hash = new InviteEmailHasher(config(SECRET_A)).hash('x@example.com')

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toBe(createHash('sha256').update('x@example.com').digest('hex'))
    expect(hash).not.toBe(
      createHash('sha256').update('bookswap-invite-email:v2:x@example.com').digest('hex'),
    )
  })

  it('depends on the secret', () => {
    expect(new InviteEmailHasher(config(SECRET_A)).hash('x@example.com')).not.toBe(
      new InviteEmailHasher(config(SECRET_B)).hash('x@example.com'),
    )
  })

  it('normalises case and surrounding spaces', () => {
    const hasher = new InviteEmailHasher(config(SECRET_A))

    expect(hasher.hash('  X@Example.COM ')).toBe(hasher.hash('x@example.com'))
  })

  it('without a secret uses an unpredictable per-process key, stable inside the instance', () => {
    const one = new InviteEmailHasher(config())
    const two = new InviteEmailHasher(config())

    expect(one.hash('x@example.com')).toBe(one.hash('x@example.com'))
    expect(one.hash('x@example.com')).not.toBe(two.hash('x@example.com'))
  })
})
