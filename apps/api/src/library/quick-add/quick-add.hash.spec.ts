import type { QuickAddRequest } from '@bookswap/shared'
import { requestHashOf } from './quick-add.hash'

const base: QuickAddRequest = {
  operationId: '3f8e2f0e-8f6a-4a36-9a43-0f0d1b8f5c11',
  target: { kind: 'EXISTING_EDITION', editionId: 'e-1' },
}

describe('requestHashOf', () => {
  it('не залежить від operationId: ключ ідентифікує дію, а не її вміст', () => {
    expect(requestHashOf(base)).toBe(
      requestHashOf({ ...base, operationId: '11111111-1111-4111-8111-111111111111' }),
    )
  })

  it('однаково для різної форми запису того самого', () => {
    const explicit = requestHashOf({
      ...base,
      entryMethod: 'MANUAL',
      copy: { condition: 'GOOD', note: null },
    })
    const reordered = requestHashOf({
      target: { editionId: 'e-1', kind: 'EXISTING_EDITION' },
      operationId: base.operationId,
      copy: { condition: 'GOOD' },
    })

    expect(explicit).toBe(reordered)
    expect(requestHashOf({ ...base, copy: {} })).toBe(requestHashOf(base))
  })

  it.each<[string, Partial<QuickAddRequest>]>([
    ['інше видання', { target: { kind: 'EXISTING_EDITION', editionId: 'e-2' } }],
    ['інший спосіб додавання', { entryMethod: 'BARCODE' }],
    ['інший стан', { copy: { condition: 'WORN' } }],
    ['інша нотатка', { copy: { note: 'моя' } }],
    ['інша видимість', { copy: { visibility: 'PRIVATE' } }],
  ])('змінюється, коли змінюється вміст: %s', (_name, change) => {
    expect(requestHashOf({ ...base, ...change })).not.toBe(requestHashOf(base))
  })

  it('не містить нотатки у відкритому вигляді', () => {
    const hash = requestHashOf({ ...base, copy: { note: 'ПРИВАТНЕ' } })

    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain('ПРИВАТНЕ')
  })
})
