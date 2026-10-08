import { LIBRARY_LIMITS } from '@bookswap/shared'
import { parseNoteDraft } from './note-draft'

describe('parseNoteDraft', () => {
  it('sends the trimmed text', () => {
    expect(parseNoteDraft('  з автографом \n')).toEqual({ ok: true, note: 'з автографом' })
  })

  it('treats an empty or blank box as "no note", not as stored whitespace', () => {
    expect(parseNoteDraft('')).toEqual({ ok: true, note: null })
    expect(parseNoteDraft('   \n  ')).toEqual({ ok: true, note: null })
  })

  it('accepts a note of exactly the limit and refuses one character more', () => {
    expect(parseNoteDraft('я'.repeat(LIBRARY_LIMITS.noteMax))).toEqual({
      ok: true,
      note: 'я'.repeat(LIBRARY_LIMITS.noteMax),
    })

    const tooLong = parseNoteDraft('я'.repeat(LIBRARY_LIMITS.noteMax + 1))

    expect(tooLong.ok).toBe(false)
    expect(tooLong).toMatchObject({ message: expect.stringContaining('1000') })
  })
})
