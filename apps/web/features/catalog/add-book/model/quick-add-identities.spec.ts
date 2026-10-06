import { externalIdentities } from './external-target'
import { identitiesOf, isbnIdentity } from './quick-add-identities'

const ISBN = '9783161484100'

describe('identitiesOf', () => {
  it('names the edition and its ISBN, so both share one slot', () => {
    expect(identitiesOf({ edition: { id: 'e-1', isbn13: ISBN } })).toEqual([
      'edition:e-1',
      `isbn:${ISBN}`,
    ])
  })

  it('has only the edition identity when the ISBN is unknown', () => {
    expect(identitiesOf({ edition: { id: 'e-1', isbn13: null } })).toEqual(['edition:e-1'])
  })
})

describe('isbnIdentity', () => {
  it('is the identity a local edition and an external record with the same ISBN both carry', () => {
    const external = externalIdentities({
      id: 'GOOGLE_BOOKS:v',
      kind: 'EDITION',
      sources: ['GOOGLE_BOOKS'],
      title: 'Зовнішня',
      isbn13: ISBN,
    })

    expect(identitiesOf({ edition: { id: 'e-1', isbn13: ISBN } })).toContain(isbnIdentity(ISBN))
    expect(external).toContain(isbnIdentity(ISBN))
  })
})
