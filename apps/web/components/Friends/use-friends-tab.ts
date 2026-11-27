'use client'

import { useSearchParams } from 'next/navigation'
import { friendsTabHref, readFriendsTab, type FriendsTab } from './friends-view'

/**
 * The open tab of `/friends`, read from and written to `?tab=` (CONVENTIONS §3.8): a reload and a
 * shared link open the same tab.
 *
 * Written through the History API, as `useLoansAddress` does: Next folds `replaceState` into its
 * router and updates `useSearchParams` without asking the server for the page again. Always
 * `replace`: a tab is not a navigation step, and Back leaves the page instead of walking the tabs.
 */
export function useFriendsTab(): { tab: FriendsTab; selectTab: (tab: FriendsTab) => void } {
  const parameters = useSearchParams()

  return {
    tab: readFriendsTab(parameters),
    selectTab: (tab) => {
      const href = friendsTabHref(window.location, tab)

      if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`) {
        return
      }

      window.history.replaceState(null, '', href)
    },
  }
}
