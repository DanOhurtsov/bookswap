import { authorsEqual } from './author-list'

/**
 * R10a: `authors` is sent only when the list really changed. The same author
 * may be built with its keys in a different order (the row editor spreads
 * `{ name, role }` and then adds `nameLatin`; zod output follows the schema's
 * order) — that is not a change. The order of AUTHORS is.
 */
describe('authorsEqual', () => {
  it('однакові автори з різним порядком ключів — рівні', () => {
    expect(
      authorsEqual(
        [
          { authorId: 'a-1', role: 'AUTHOR' },
          { name: 'Новий Автор', role: 'AUTHOR', nameLatin: 'Novyi Avtor' },
        ],
        [
          { role: 'AUTHOR', authorId: 'a-1' },
          { name: 'Новий Автор', nameLatin: 'Novyi Avtor', role: 'AUTHOR' },
        ],
      ),
    ).toBe(true)
  })

  it('інший порядок авторів — це зміна', () => {
    expect(
      authorsEqual(
        [
          { authorId: 'a-1', role: 'AUTHOR' },
          { authorId: 'a-2', role: 'AUTHOR' },
        ],
        [
          { authorId: 'a-2', role: 'AUTHOR' },
          { authorId: 'a-1', role: 'AUTHOR' },
        ],
      ),
    ).toBe(false)
  })

  it('різні значення полів — це зміна; null не дорівнює відсутньому ключу', () => {
    expect(
      authorsEqual([{ authorId: 'a-1', role: 'AUTHOR' }], [{ authorId: 'a-1', role: 'EDITOR' }]),
    ).toBe(false)
    expect(authorsEqual([{ name: 'Автор', nameLatin: null }], [{ name: 'Автор' }])).toBe(false)
  })
})
