// Also the way into «Позичання», «Історія» and «Вішлист»: they are sections of the library, so the
// header marks this entry as current on any of them.
const NAVBAR_LINK_LIBRARY = { href: '/library', label: 'Моя бібліотека' }

const NAVBAR_LINKS_AUTH = [
  { href: '/', label: 'Головна' },
  { href: '/catalog', label: 'Каталог' },
  NAVBAR_LINK_LIBRARY,
  { href: '/friends', label: 'Друзі' },
]

// Shown only while the server reports guestLoans on (T9).
const NAVBAR_LINK_CONTACTS = { href: '/contacts', label: 'Контакти' }

const NAVBAR_LINKS_GUEST = [
  { href: '/register', label: 'Створити акаунт' },
  { href: '/login', label: 'Увійти' },
]

const NAVBAR_PROFILE_LINKS = [
  { href: '/profile', label: 'Профіль' },
  { href: '/reading-list', label: 'Список читання' },
]

// exports
export {
  NAVBAR_LINK_CONTACTS,
  NAVBAR_LINK_LIBRARY,
  NAVBAR_LINKS_AUTH,
  NAVBAR_LINKS_GUEST,
  NAVBAR_PROFILE_LINKS,
}
