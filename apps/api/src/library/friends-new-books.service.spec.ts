import { VISIBILITY } from '@bookswap/shared'
import { copyVisibleTo } from '../access/visibility'
import { VISIBLE_TO_FRIENDS } from './friends-new-books.service'

describe('VISIBLE_TO_FRIENDS', () => {
  it('a copy passes the feed filter exactly when the §9 matrix shows it to a friend', () => {
    for (const library of VISIBILITY) {
      for (const copy of VISIBILITY) {
        const filtered = VISIBLE_TO_FRIENDS.includes(library) && VISIBLE_TO_FRIENDS.includes(copy)

        expect({ library, copy, visible: filtered }).toEqual({
          library,
          copy,
          visible: copyVisibleTo('FRIEND', library, copy),
        })
      }
    }
  })

  it('a private library or a private copy never reaches the feed', () => {
    expect(VISIBLE_TO_FRIENDS).not.toContain('PRIVATE')
  })
})
