import { redirect } from 'next/navigation'
import { LOANS_HISTORY_HREF } from '@/features/loans'

/**
 * BS-143: the personal history is the third tab of «Позичання». Old links land there, decided on
 * the server, so the old screen is never rendered first. The target is fixed: `/history` never read
 * its query string, so nothing is carried over. A guest is sent on by the loans page's own guard.
 */
export default function HistoryPage(): never {
  redirect(LOANS_HISTORY_HREF)
}
