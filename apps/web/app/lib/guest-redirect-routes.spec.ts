import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BS-146: every signed-in page sends a guest to sign in through `useGuestRedirect`, so the guest
 * comes back to that page afterwards. Checked as source text, like `alias-privacy.spec.ts`: the point
 * is "no route was left out", which no render of one screen can show. Every `page.tsx` has to be
 * classified here, so a new route is a decision, not an omission.
 */
const web = join(__dirname, '../..')
const read = (path: string) => readFileSync(join(web, path), 'utf8')

/** Route → the file whose component guards it. */
const GUARDED: Record<string, string> = {
  '/catalog': 'app/(pages)/catalog/page.tsx',
  '/catalog/new': 'features/catalog/add-book/components/AddBookScreen.tsx',
  '/contacts': 'app/(pages)/contacts/page.tsx',
  '/copies/[id]/history': 'app/(pages)/copies/[id]/history/page.tsx',
  '/friends': 'components/Friends/FriendsSessionBoundary.tsx',
  '/friends/search': 'features/user-search/components/UserSearchScreen.tsx',
  '/library': 'features/library/own-library/components/LibraryScreen.tsx',
  '/library/[entryId]': 'features/library/own-book/components/OwnBookScreen.tsx',
  '/loans': 'features/loans/components/LoansScreen.tsx',
  '/loans/guest': 'app/(pages)/loans/guest/page.tsx',
  '/notifications': 'app/(pages)/notifications/page.tsx',
  '/notifications/settings': 'app/(pages)/notifications/settings/page.tsx',
  '/profile': 'features/profile/components/ProfileScreen.tsx',
  '/users/[id]/library': 'app/(pages)/users/[id]/library/page.tsx',
  '/wishlist': 'app/(pages)/wishlist/page.tsx',
  '/works/[id]': 'app/(pages)/works/[id]/page.tsx',
}

/** Signed-in pages that get there another way. */
const OTHERWISE_SIGNED_IN = {
  // Its token stays out of every URL: stashed, then back to the bare `/invite` (`InviteAcceptance`).
  '/invite': 'own flow',
  // Server redirects to a guarded page; the guest is sent on from there, with the final address.
  '/history': 'redirect to /loans',
  '/reading-list': 'redirect to /library',
  // No session guard: the API's 401 shows `ImportFailureNotice`, whose «Увійти» is a `LoginLink`.
  '/library/imports': 'API 401',
  '/library/imports/[id]': 'API 401',
}

const PUBLIC = [
  '/',
  '/forgot-password',
  '/guest-loan-confirmation',
  '/login',
  '/register',
  '/reset-password',
  '/verify-email',
]

function routes(): string[] {
  return readdirSync(join(web, 'app'), { recursive: true, encoding: 'utf8' })
    .filter((path) => /(^|\/)page\.tsx$/.test(path))
    .map((path) => `/${path.replace(/(^|\/)page\.tsx$/, '').replace(/\([^)]+\)\/?/g, '')}`)
    .map((route) => (route.length > 1 ? route.replace(/\/$/, '') : route))
    .sort()
}

function sourcesOf(directory: string): string[] {
  return readdirSync(join(web, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.spec\.tsx?$/.test(path))
    .map((path) => `${directory}/${path}`)
}

describe('BS-146: guests come back to the signed-in page they asked for', () => {
  it('classifies every route of the app', () => {
    expect(routes()).toEqual(
      [...Object.keys(GUARDED), ...Object.keys(OTHERWISE_SIGNED_IN), ...PUBLIC].sort(),
    )
  })

  it.each(Object.entries(GUARDED))('%s is guarded by useGuestRedirect', (_route, file) => {
    expect(read(file)).toMatch(/\buseGuestRedirect\((\w+\.)+status\)/)
  })

  // Allowed bare `/login`: logging out, the header of public pages, the invitation's own flow,
  // and the public password pages.
  const BARE_LOGIN_ALLOWED = new Set([
    'components/NavBar/NavBarAvatar.tsx',
    'constants/navigation.tsx',
    'features/network/components/InviteAcceptance.tsx',
    'app/(pages)/forgot-password/page.tsx',
    'app/(pages)/reset-password/page.tsx',
  ])

  it.each(
    ['app', 'components', 'features'].flatMap(sourcesOf).filter((f) => !BARE_LOGIN_ALLOWED.has(f)),
  )('%s never sends anyone to a bare /login', (file) => {
    const source = read(file)

    expect(source).not.toMatch(/\.(replace|push)\(\s*['"`]\/login\b/)
    expect(source).not.toMatch(/href=\{?\s*['"`]\/login['"`]/)
  })
})
