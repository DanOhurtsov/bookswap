/** @jest-environment jsdom */

import {
  clearStashedInviteToken,
  readStashedInviteToken,
  stashInviteToken,
  tokenFromHash,
} from './invite-token'

describe('tokenFromHash', () => {
  it('reads and decodes the fragment', () => {
    expect(tokenFromHash('#abc-_123')).toBe('abc-_123')
    expect(tokenFromHash('#a%2Bb')).toBe('a+b')
  })

  it.each(['', '#', '#%E0%A4%A', `#${'a'.repeat(129)}`])('ignores %j', (hash) => {
    expect(tokenFromHash(hash)).toBeUndefined()
  })
})

describe('sessionStorage stash', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    window.sessionStorage.clear()
  })

  it('stashes, reads and clears', () => {
    stashInviteToken('tok')
    expect(readStashedInviteToken()).toBe('tok')
    clearStashedInviteToken()
    expect(readStashedInviteToken()).toBeUndefined()
  })

  it('never throws when storage is unavailable', () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(() => {
      stashInviteToken('tok')
      clearStashedInviteToken()
    }).not.toThrow()
    expect(readStashedInviteToken()).toBeUndefined()
  })
})
