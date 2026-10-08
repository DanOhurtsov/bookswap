/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import OwnBookPage from './page'

jest.mock('@/features/library/own-book/index.client', () => ({
  OwnBookScreen: ({ entryId }: { entryId: string }) => <p>Own book screen: {entryId}</p>,
}))

const source = readFileSync(__filename.replace('page.server.spec.tsx', 'page.tsx'), 'utf8')

describe('route /library/[entryId]', () => {
  it('hands the id of the copy from the address to the screen', async () => {
    render(await OwnBookPage({ params: Promise.resolve({ entryId: 'copy-9' }) }))

    expect(screen.getByText('Own book screen: copy-9')).toBeInTheDocument()
  })

  it('stays routing-only (§1.1): a server component of at most 50 lines, no UI of its own', () => {
    expect(source).not.toContain("'use client'")
    expect(source.split('\n').length).toBeLessThanOrEqual(50)
    expect(source).not.toContain('className')
    expect(source).not.toContain('useState')
  })
})
