import type { Metadata } from 'next'
import type { ReactNode } from 'react'

// The token sits in the URL fragment; never send this address onward as a Referer.
export const metadata: Metadata = { referrer: 'no-referrer' }

export default function InviteLayout({ children }: { children: ReactNode }) {
  return children
}
