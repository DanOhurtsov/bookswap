'use client'

import { useSession } from '@/app/lib/use-session'
import { Skeleton } from '@/components/ui/skeleton'
import { greetingName } from '../model/greeting'

/**
 * BS-147: the top of the home page (canvas «Main Page»). A signed-in reader is greeted by their first
 * name; a guest — and a visitor whose session could not be read — gets the service's own title and
 * description. While the session is being read a placeholder holds the line, unless the server
 * already knows there is no session (`knownGuest`): then the guest's text is there from the first
 * paint and nothing flashes. Sends no requests of its own.
 */
export function HomeGreeting({ knownGuest }: { knownGuest: boolean }) {
  const { state: session } = useSession()

  if (session.status === 'authenticated') {
    const name = greetingName(session.user.displayName)

    return (
      <h1 className="home-greeting__title">{name === null ? 'Вітаємо!' : `Вітаємо, ${name}`}</h1>
    )
  }

  if (session.status === 'loading' && !knownGuest) {
    return <Skeleton aria-hidden="true" className="h-9 w-64 md:h-10 lg:h-11" />
  }

  return (
    <header>
      <h1 className="home-greeting__title">BookSwap</h1>
      <p className="home-greeting__lede">
        Сервіс обміну фізичними книжками. Готові акаунт, профіль, дружба, каталог, особиста
        бібліотека, позичання з історією та сповіщення в застосунку.
      </p>
    </header>
  )
}
