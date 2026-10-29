import { personHref } from './person-href'

describe('personHref (BS-148)', () => {
  it('is the person’s nickname under /u/, never their id', () => {
    expect(personHref({ handle: 'danylo-ohurtsov' })).toBe('/u/danylo-ohurtsov')
  })
})
