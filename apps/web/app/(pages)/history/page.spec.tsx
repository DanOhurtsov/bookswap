import { readFileSync } from 'node:fs'
import HistoryPage from './page'

/** BS-143: `/history` is only a server redirect to the history tab of «Позичання». */

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

describe('/history', () => {
  it('redirects to /loans?tab=history while rendering on the server, before anything else', () => {
    expect(() => HistoryPage()).toThrow('NEXT_REDIRECT /loans?tab=history')
    expect(redirect).toHaveBeenCalledTimes(1)
    expect(redirect).toHaveBeenCalledWith('/loans?tab=history')
  })

  it('is a server component that renders nothing of the old screen', () => {
    expect(source).not.toContain("'use client'")
    expect(source).not.toMatch(/useMyHistory|useSession|LibrarySectionPage|<main/)
  })

  it('takes no query parameters to carry over: the target is fixed', () => {
    expect(source).not.toContain('searchParams')
  })
})
