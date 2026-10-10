const NAVBAR_LINKS_AUTH = [
  { href: '/', label: 'Головна' },
  { href: '/catalog', label: 'Каталог' },
  { href: '/library', label: 'Моя бібліотека' },
  { href: '/loans', label: 'Позичання' },
  { href: '/friends', label: 'Друзі' },
  { href: '/history', label: 'Історія' },
]

// Shown only while the server reports guestLoans on (T9).
const NAVBAR_LINK_CONTACTS = { href: '/contacts', label: 'Контакти' }

const NAVBAR_LINKS_GUEST = [
  { href: '/register', label: 'Створити акаунт' },
  { href: '/login', label: 'Увійти' },
]

const NAVBAR_PROFILE_LINKS = [
  { href: '/profile', label: 'Профіль' },
  { href: '/wishlist', label: 'Вішлист' },
  { href: '/reading-list', label: 'Список читання' },
]

// exports
export { NAVBAR_LINK_CONTACTS, NAVBAR_LINKS_AUTH, NAVBAR_LINKS_GUEST, NAVBAR_PROFILE_LINKS }
