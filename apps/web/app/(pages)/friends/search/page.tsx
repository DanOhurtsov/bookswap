import { Suspense } from 'react'
import { Shell } from '@/components/Shell'
import { UserSearchScreen } from '@/features/user-search/index.client'

export default function FriendsSearchPage() {
  return (
    // `useSearchParams` in the screen needs a boundary of its own.
    <Suspense
      fallback={
        <Shell title="Пошук людей">
          <p className="text-sm text-muted-foreground">Читаю запит…</p>
        </Shell>
      }
    >
      <UserSearchScreen />
    </Suspense>
  )
}
