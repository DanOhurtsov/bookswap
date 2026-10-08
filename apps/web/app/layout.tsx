import type { Metadata } from 'next'
import Script from 'next/script'
import type { ReactNode } from 'react'
import './globals.css'
import { Providers } from './lib/query-client'
import { SessionProvider } from './lib/use-session'
import { THEME_INITIALIZER_SCRIPT } from './lib/theme'
import { NavBar } from '@/components/NavBar/NavBar'

export const metadata: Metadata = {
  title: 'BookSwap',
  description: 'Сервіс обміну фізичними книжками',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uk" suppressHydrationWarning>
      <body>
        <Script id="theme-initializer" strategy="beforeInteractive">
          {THEME_INITIALIZER_SCRIPT}
        </Script>
        <SessionProvider>
          <Providers>
            <NavBar />
            {children}
          </Providers>
        </SessionProvider>
      </body>
    </html>
  )
}
