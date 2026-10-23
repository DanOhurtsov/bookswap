import { HealthStatus } from '@/components/DEV/HealthStatus'
import { FriendsReading } from '@/features/friends-reading/index.client'
import { fetchReadingStatsSnapshot } from '@/features/reading-status'
import { HomeReadingStats } from '@/features/reading-status/index.client'

/**
 * Public, and rendered per request: the reading stats are read here, on the server, from the
 * visitor's own cookie (BS-145), so they are on the first paint. That read makes the route dynamic —
 * nothing private is fetched at build time — and a guest gets no stats request at all.
 * `fetchReadingStatsSnapshot` never throws. What friends are reading (BS-137) is read in the browser,
 * once the session is known; `HealthStatus` still talks to the API from the browser too.
 */
export default async function HomePage() {
  const readingStats = await fetchReadingStatsSnapshot()

  return (
    <main className="page">
      <h1>BookSwap</h1>
      <p className="lede">
        Сервіс обміну фізичними книжками. Готові акаунт, профіль, дружба, каталог, особиста
        бібліотека, позичання з історією та сповіщення в застосунку.
      </p>
      <HomeReadingStats initial={readingStats} />
      <FriendsReading />
      <HealthStatus />
    </main>
  )
}
