import { readFileSync } from 'node:fs'
import { NAVBAR_LINKS_AUTH, NAVBAR_PROFILE_LINKS } from '@/constants/navigation'
import ReadingListPage from './page'

/** BS-145: `/reading-list` is only a server redirect to the library, and nothing links to it. */

const redirect = jest.fn((path: string): never => {
  throw new Error(`NEXT_REDIRECT ${path}`)
})

jest.mock('next/navigation', () => ({
  redirect: (path: string) => redirect(path),
}))

const source = readFileSync(__filename.replace('page.spec.tsx', 'page.tsx'), 'utf8')

beforeEach(() => {
  redirect.mockClear()
})

describe('/reading-list', () => {
  it('redirects to /library while rendering on the server, before anything else', () => {
    expect(() => ReadingListPage()).toThrow('NEXT_REDIRECT /library')
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith('/library')
  })

  it('is a server component that renders nothing of the old screen', () => {
    expect(source).not.toContain("'use client'")
    expect(source).not.toMatch(/ReadingListScreen|useSession|<main/)
  })

  it('takes no query parameters to carry over: the target is fixed', () => {
    expect(source).not.toContain('searchParams')
  })

  it('is linked from no navigation', () => {
    const hrefs = [...NAVBAR_LINKS_AUTH, ...NAVBAR_PROFILE_LINKS].map((link) => link.href)

    expect(hrefs).not.toContain('/reading-list')
    expect([...NAVBAR_LINKS_AUTH, ...NAVBAR_PROFILE_LINKS].map((link) => link.label)).not.toContain(
      'Список читання',
    )
  })
})
