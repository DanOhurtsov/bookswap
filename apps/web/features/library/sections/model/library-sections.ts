/**
 * «Моя бібліотека» is one section of the app spread over three routes. This list is the one place that
 * says which routes they are and in what order; the section's own navigation and the header entry
 * both read the current section from here. The personal history is a tab inside «Позичання»
 * (`/loans?tab=history`, BS-143), not a section of its own.
 */
export type LibrarySection = {
  href: string
  label: string
}

export const LIBRARY_SECTIONS = [
  { href: '/library', label: 'Книжки' },
  { href: '/loans', label: 'Позичання' },
  { href: '/wishlist', label: 'Вішлист' },
] as const satisfies readonly LibrarySection[]

/**
 * The section a pathname belongs to: the route itself or any page nested under it (`/library/:copyId`,
 * `/loans/guest`). Matching is by whole path segments, so `/libraryish` or someone else's library at
 * `/users/:id/library` belong to no section.
 */
export function currentLibrarySection(pathname: string): LibrarySection | undefined {
  return LIBRARY_SECTIONS.find(
    (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
  )
}
