import { redirect } from 'next/navigation'

/**
 * BS-145: the separate reading list is gone — reading statuses are counted on the home page and set
 * in the library. Old links land in the library, decided on the server, so the old screen is never
 * rendered first. The target is fixed: the list's query parameters mean nothing there and are
 * dropped. A guest is sent on by the library's own guard.
 */
export default function ReadingListPage(): never {
  redirect('/library')
}
