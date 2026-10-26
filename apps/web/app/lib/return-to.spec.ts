/** @jest-environment jsdom */

import { currentAddress, loginHref, returnToQuery, safeReturnTo } from './return-to'

describe('safeReturnTo', () => {
  it('accepts exactly /invite', () => {
    expect(safeReturnTo('/invite')).toBe('/invite')
  })

  it.each([
    '/library',
    '/profile?x=1',
    '/loans?tab=history&historyView=lent',
    '/works/w-1#editions',
    '/catalog?q=%D0%9A%D0%BE%D0%B1%D0%B7%D0%B0%D1%80&page=2#top',
    '/users/u%201/library',
    '/',
    '/?returnTo=%2Flibrary',
    // A page that no longer exists is still ours: it shows its own 404 after login.
    '/works/deleted-work',
    '/no-such-page',
  ])('accepts the internal address %j as it is', (value) => {
    expect(safeReturnTo(value)).toBe(value)
  })

  it.each([
    // other hosts and schemes
    '//evil.example',
    '//evil.example/library',
    'https://evil.example/invite',
    'http:/evil.example',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:a@b.c',
    'library',
    ' /invite',
    '',
    // backslashes, read by browsers as `/`
    '\\invite',
    '/\\evil.example',
    '\\\\evil.example',
    '/library\\..\\x',
    // control characters, some of which the URL parser silently drops
    '/\t/evil.example',
    '/\n/evil.example',
    '/li\rbrary',
    '/library\u0000',
    '/library\u007f',
    '/library\u001b',
    // anything the URL parser would rewrite is not the address that was asked for
    '/invite/../x',
    '/library/./x',
    '/%2e%2e/x',
    '/library?q=a b',
    '/бібліотека',
    '/library#',
    '/library?',
    // the invitation token never travels in a URL
    '/invite?x=1',
    '/invite#t',
    '/invite/',
    // signing in again after signing in is a loop
    '/login',
    '/login/',
    '/login?returnTo=%2Flibrary',
    '/login#x',
    '/register',
    '/register/',
    '/register?returnTo=%2Finvite',
  ])('rejects %j and falls back', (value) => {
    expect(safeReturnTo(value)).toBe('/')
  })

  it('falls back for missing values and honours a custom fallback', () => {
    expect(safeReturnTo(null)).toBe('/')
    expect(safeReturnTo(undefined, '/x')).toBe('/x')
    expect(safeReturnTo('//evil', '')).toBe('')
  })
})

describe('returnToQuery', () => {
  it('keeps only an allowed target', () => {
    expect(returnToQuery('/invite')).toBe('?returnTo=%2Finvite')
    expect(returnToQuery('/works/w-1?x=1#y')).toBe('?returnTo=%2Fworks%2Fw-1%3Fx%3D1%23y')
    expect(returnToQuery('//evil')).toBe('')
    expect(returnToQuery('/login')).toBe('')
    expect(returnToQuery(null)).toBe('')
  })
})

describe('loginHref', () => {
  it('carries the target, query and fragment whole, encoded as one parameter', () => {
    const href = loginHref('/loans?tab=history&historyView=lent#loan-1')

    expect(href).toBe('/login?returnTo=%2Floans%3Ftab%3Dhistory%26historyView%3Dlent%23loan-1')
    expect(new URL(href, 'https://x.invalid').searchParams.get('returnTo')).toBe(
      '/loans?tab=history&historyView=lent#loan-1',
    )
  })

  it('is plain /login when the target may not be resumed', () => {
    expect(loginHref('https://evil.example')).toBe('/login')
    expect(loginHref('/login?returnTo=%2Flibrary')).toBe('/login')
  })
})

describe('currentAddress', () => {
  it('is path, query and fragment of the page on screen', () => {
    window.history.replaceState(null, '', '/works/w-1?tab=x#editions')

    expect(currentAddress()).toBe('/works/w-1?tab=x#editions')
  })

  it('round-trips through loginHref and safeReturnTo unchanged', () => {
    window.history.replaceState(null, '', '/catalog?q=Кобзар&scope=friends#результати')

    const returnTo = new URL(loginHref(currentAddress()), 'https://x.invalid').searchParams.get(
      'returnTo',
    )

    expect(returnTo).toBe(currentAddress())
    expect(safeReturnTo(returnTo)).toBe(currentAddress())
  })
})
