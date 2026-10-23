// Also the way into «Позичання», «Історія» and «Вішлист»: they are sections of the library, so the
// header marks this entry as current on any of them.
const NAVBAR_LINK_LIBRARY = { href: '/library', label: 'Моя бібліотека' }

// Current on `/friends` and the pages nested under it, such as `/friends/search`.
const NAVBAR_LINK_FRIENDS = { href: '/friends', label: 'Друзі' }

const NAVBAR_LINKS_AUTH = [
  { href: '/', label: 'Головна' },
  { href: '/catalog', label: 'Каталог' },
  NAVBAR_LINK_LIBRARY,
  NAVBAR_LINK_FRIENDS,
]

// Shown only while the server reports guestLoans on (T9).
const NAVBAR_LINK_CONTACTS = { href: '/contacts', label: 'Контакти' }

const NAVBAR_LINKS_GUEST = [
  { href: '/register', label: 'Створити акаунт' },
  { href: '/login', label: 'Увійти' },
]

const NAVBAR_PROFILE_LINKS = [{ href: '/profile', label: 'Профіль' }]

// exports
export {
  NAVBAR_LINK_CONTACTS,
  NAVBAR_LINK_FRIENDS,
  NAVBAR_LINK_LIBRARY,
  NAVBAR_LINKS_AUTH,
  NAVBAR_LINKS_GUEST,
  NAVBAR_PROFILE_LINKS,
}
