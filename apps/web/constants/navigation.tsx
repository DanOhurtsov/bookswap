const NAVBAR_LINKS_AUTH = [
  { href: '/', label: 'Головна' },
  { href: '/friends', label: 'Друзі' },
  // { href: '/catalog', label: 'Каталог' },
  { href: '/history', label: 'Історія' },
  // { href: '/notifications', label: 'Сповіщення' },
  // { href: '/notifications/settings', label: 'Налаштування сповіщень' },
]

// Shown only while the server reports guestLoans on (T9).
const NAVBAR_LINK_CONTACTS = { href: '/contacts', label: 'Контакти' }

const NAVBAR_LINKS_GUEST = [
  { href: '/register', label: 'Створити акаунт' },
  { href: '/login', label: 'Увійти' },
]

const NAVBAR_PROFILE_LINKS = [
  { href: '/profile', label: 'Профіль' },
  { href: '/library', label: 'Моя бібліотека' },
  { href: '/wishlist', label: 'Вішлист' },
]

// exports
export { NAVBAR_LINK_CONTACTS, NAVBAR_LINKS_AUTH, NAVBAR_LINKS_GUEST, NAVBAR_PROFILE_LINKS }
