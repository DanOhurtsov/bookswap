import type { Metadata } from 'next'
import type { ReactNode } from 'react'

// Токен — у фрагменті адреси: адресу не можна передавати далі в `Referer` і не можна індексувати.
export const metadata: Metadata = {
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

export default function GuestLoanConfirmationLayout({ children }: { children: ReactNode }) {
  return children
}
