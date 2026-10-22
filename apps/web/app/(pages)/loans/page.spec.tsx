/** @jest-environment jsdom */

import { readFileSync } from 'node:fs'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import LoansPage from './page'

/**
 * BS-143: the route file stays routing only (§1.1, §2.2) — no `'use client'`, no screen left under
 * `app/`; the screen itself and its tests live in `features/loans`.
 */
jest.mock('@/features/loans/index.client', () => ({
  LoansScreen: () => <p>Loans screen</p>,
}))

const source = readFileSync(__filename.replace('page.spec.tsx', 'page.tsx'), 'utf8')

describe('/loans', () => {
  it('renders the loans screen of the feature', () => {
    render(<LoansPage />)

    expect(screen.getByText('Loans screen')).toBeInTheDocument()
  })

  it('is a thin server component: no client directive, hooks or markup of its own', () => {
    expect(source).not.toContain("'use client'")
    expect(source).not.toMatch(/\buse[A-Z]\w*\(|<main|<Tabs|apiRequest/)
    expect(source.split('\n').length).toBeLessThan(25)
  })
})
