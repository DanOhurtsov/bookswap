import { FriendsReading } from '@/features/friends-reading/index.client'
import { HomeGreeting } from '@/features/home/index.client'
import { fetchReadingStatsSnapshot } from '@/features/reading-status'
import { HomeReadingStats } from '@/features/reading-status/index.client'

/**
 * Public, and rendered per request: the reading stats are read here, on the server, from the
 * visitor's own cookie (BS-145), so they are on the first paint. That read makes the route dynamic —
 * nothing private is fetched at build time — and a guest gets no stats request at all.
 * `fetchReadingStatsSnapshot` never throws; its «guest» also lets the greeting show a guest's text
 * from the first paint (BS-147). What friends are reading (BS-137) is read in the browser, once the
 * session is known.
 */
export default async function HomePage() {
  const readingStats = await fetchReadingStatsSnapshot()

  return (
    // The canvas container is 1120 px; `.page` keeps the app's gutters around it.
    <main className="page home-page canvas-theme">
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-8 md:gap-10 lg:gap-12">
        <HomeGreeting knownGuest={readingStats.status === 'guest'} />
        <HomeReadingStats initial={readingStats} />
        <FriendsReading />
      </div>
    </main>
  )
}
