import {
  ACTIVATION_NEXT_ACTION,
  ACTIVATION_TARGET,
  activationNextActionFor,
  activationNextActionSchema,
  activationResponseSchema,
  hasReachedActivationTarget,
  type ActivationResponse,
} from './activation'

/** A response that agrees with itself at `ownedCopyCount`, built the way the API builds one. */
function progressAt(ownedCopyCount: number): ActivationResponse {
  return {
    ownedCopyCount,
    target: ACTIVATION_TARGET,
    hasReachedTarget: hasReachedActivationTarget(ownedCopyCount),
    nextAction: activationNextActionFor(ownedCopyCount),
  }
}

describe('ACTIVATION_TARGET', () => {
  it('is the ten books R11 names', () => {
    expect(ACTIVATION_TARGET).toBe(10)
  })
})

describe('activationNextActionSchema', () => {
  it('accepts exactly the two actions and nothing else', () => {
    expect(ACTIVATION_NEXT_ACTION).toEqual(['ADD_BOOKS', 'INVITE_FRIENDS'])

    for (const action of ACTIVATION_NEXT_ACTION) {
      expect(activationNextActionSchema.parse(action)).toBe(action)
    }

    // Stage 9 owns invite links; nothing about them leaks into this contract.
    expect(() => activationNextActionSchema.parse('INVITE_LINK')).toThrow()
    expect(() => activationNextActionSchema.parse('')).toThrow()
  })
})

describe('the threshold rule', () => {
  it('turns over at the tenth book, not the ninth or the eleventh', () => {
    expect(hasReachedActivationTarget(9)).toBe(false)
    expect(hasReachedActivationTarget(ACTIVATION_TARGET)).toBe(true)
    expect(hasReachedActivationTarget(11)).toBe(true)

    expect(activationNextActionFor(9)).toBe('ADD_BOOKS')
    expect(activationNextActionFor(ACTIVATION_TARGET)).toBe('INVITE_FRIENDS')
    expect(activationNextActionFor(11)).toBe('INVITE_FRIENDS')
  })
})

describe('activationResponseSchema — valid progress', () => {
  it.each([0, 1, 9])('accepts %i copies as still adding books', (ownedCopyCount) => {
    const parsed = activationResponseSchema.parse(progressAt(ownedCopyCount))

    expect(parsed).toEqual({
      ownedCopyCount,
      target: ACTIVATION_TARGET,
      hasReachedTarget: false,
      nextAction: 'ADD_BOOKS',
    })
  })

  it.each([10, 11, 250])('accepts %i copies as ready for friends', (ownedCopyCount) => {
    const parsed = activationResponseSchema.parse(progressAt(ownedCopyCount))

    expect(parsed).toEqual({
      ownedCopyCount,
      target: ACTIVATION_TARGET,
      hasReachedTarget: true,
      nextAction: 'INVITE_FRIENDS',
    })
  })
})

describe('activationResponseSchema — inconsistent progress is invalid', () => {
  it('rejects hasReachedTarget that disagrees with the count, in both directions', () => {
    expect(() =>
      activationResponseSchema.parse({ ...progressAt(9), hasReachedTarget: true }),
    ).toThrow(/hasReachedTarget/)

    expect(() =>
      activationResponseSchema.parse({ ...progressAt(10), hasReachedTarget: false }),
    ).toThrow(/hasReachedTarget/)
  })

  it('rejects ADD_BOOKS once the shelf has ten books or more', () => {
    expect(() =>
      activationResponseSchema.parse({ ...progressAt(10), nextAction: 'ADD_BOOKS' }),
    ).toThrow(/nextAction/)

    expect(() =>
      activationResponseSchema.parse({ ...progressAt(42), nextAction: 'ADD_BOOKS' }),
    ).toThrow(/nextAction/)
  })

  it('rejects INVITE_FRIENDS below ten books', () => {
    expect(() =>
      activationResponseSchema.parse({ ...progressAt(0), nextAction: 'INVITE_FRIENDS' }),
    ).toThrow(/nextAction/)

    expect(() =>
      activationResponseSchema.parse({ ...progressAt(9), nextAction: 'INVITE_FRIENDS' }),
    ).toThrow(/nextAction/)
  })

  it('names every disagreement, not just the first one', () => {
    const result = activationResponseSchema.safeParse({
      ownedCopyCount: 3,
      target: ACTIVATION_TARGET,
      hasReachedTarget: true,
      nextAction: 'INVITE_FRIENDS',
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'hasReachedTarget',
      'nextAction',
    ])
  })
})

describe('activationResponseSchema — shape', () => {
  it('rejects a target the server invented instead of the contract one', () => {
    expect(() => activationResponseSchema.parse({ ...progressAt(1), target: 5 })).toThrow()
    expect(() => activationResponseSchema.parse({ ...progressAt(1), target: 20 })).toThrow()
  })

  it('rejects a count that is negative or not a whole book', () => {
    expect(() => activationResponseSchema.parse({ ...progressAt(0), ownedCopyCount: -1 })).toThrow()
    expect(() =>
      activationResponseSchema.parse({ ...progressAt(1), ownedCopyCount: 1.5 }),
    ).toThrow()
  })

  it('rejects a missing field and an extra one', () => {
    const { nextAction: _dropped, ...withoutNextAction } = progressAt(2)

    expect(() => activationResponseSchema.parse(withoutNextAction)).toThrow()

    // Strict: an endpoint that starts leaking book titles here fails the parse
    // rather than quietly widening what /me/activation returns.
    expect(() =>
      activationResponseSchema.parse({ ...progressAt(2), recentTitles: ['Шантарам'] }),
    ).toThrow()
  })
})
