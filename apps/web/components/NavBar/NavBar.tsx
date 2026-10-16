'use client'

import { useSession } from '@/app/lib/use-session'
import { NavContent } from '@/components/NavBar/NavBarContent'

export const NavBar = () => {
  const { state } = useSession()

  return (
    // The bar's background and border span the viewport; its content sits in the page geometry, so
    // every session state lines up with the page below (BS-133).
    <div
      className="sticky top-0 z-50 border-b border-(--line) bg-(--bg) py-3"
      aria-label="Основні дії"
      aria-busy={state.status === 'loading'}
    >
      <div className="page-container">
        <NavContent state={state} />
      </div>
    </div>
  )
}
