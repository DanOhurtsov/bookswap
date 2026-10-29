import { LIBRARY_SECTIONS, currentLibrarySection } from './library-sections'

describe('розділи «Моєї бібліотеки»', () => {
  it('три розділи йдуть у погодженому порядку й ведуть на наявні маршрути', () => {
    expect(LIBRARY_SECTIONS).toEqual([
      { href: '/library', label: 'Книжки' },
      { href: '/loans', label: 'Позичання' },
      { href: '/wishlist', label: 'Вішлист' },
    ])
  })

  it.each([
    ['/library', 'Книжки'],
    ['/library/copy-1', 'Книжки'],
    ['/library/imports', 'Книжки'],
    ['/library/imports/import-1', 'Книжки'],
    ['/loans', 'Позичання'],
    ['/loans/guest', 'Позичання'],
    ['/wishlist', 'Вішлист'],
  ])('%s належить до розділу «%s»', (pathname, label) => {
    expect(currentLibrarySection(pathname)?.label).toBe(label)
  })

  it.each([
    '/',
    '/catalog',
    '/friends',
    '/users/user-2/library',
    '/u/marta',
    '/copies/copy-1/history',
    '/history',
    '/reading-list',
    '/libraryish',
    '/loansharks',
  ])('%s не належить до жодного розділу', (pathname) => {
    expect(currentLibrarySection(pathname)).toBeUndefined()
  })
})
