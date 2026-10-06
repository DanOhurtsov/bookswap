'use client'

import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { readSearchAddress, searchHref } from '@/app/lib/search-page'
import { useSession } from '@/app/lib/use-session'
import { ADD_BOOK_PATH } from '../model/search-address-urls'
import { useQuickAdd } from '../model/use-quick-add'
import { AddBookManualScreen } from './AddBookManualScreen'
import { AddBookSearchScreen } from './AddBookSearchScreen'
import { pageClass, pendingStatusClass } from './screen-styles'

/**
 * Єдиний вхід у додавання книжки (docs/plan/fast-book-add.md, §2): пошук за назвою, автором або ISBN;
 * сканування лише підставляє ISBN у той самий пошук і нічого не створює.
 *
 * Стан пошуку — запит, сторінка, розмір — живе в адресі (пряме посилання, «назад» і перезавантаження
 * відновлюють список). Додавання нічого в адресі не змінює: після успіху користувач лишається в тих
 * самих результатах, на тій самій сторінці й позиції прокрутки.
 */
export function AddBookScreen() {
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') return <SessionNotice text="Перевіряю сесію…" />

  if (session.status !== 'authenticated') {
    return <SessionNotice text="Потрібен вхід. Переадресовую…" />
  }

  return <AddBookModes userId={session.user.id} />
}

type SessionNoticeProps = { text: string }

function SessionNotice({ text }: SessionNoticeProps) {
  return (
    <main className={pageClass}>
      <h1>Додати книжку</h1>
      <p className={pendingStatusClass}>{text}</p>
    </main>
  )
}

type AddBookModesProps = { userId: string }

/**
 * Picks the screen for the address. What must survive a switch between the two lives here: the add
 * slots (`quick`), the manual form's intent counter (its slots are `manual:<n>`), and whether the
 * query in the address came from the scanner.
 */
function AddBookModes({ userId }: AddBookModesProps) {
  const router = useRouter()
  const parameters = useSearchParams()
  const address = readSearchAddress(parameters)
  const quick = useQuickAdd({
    userId,
    onAdded: () => {
      router.push('/library')
    },
  })
  /** Every new form is a new intent (and a new add slot): after a success the next one can be added. */
  const [manualKey, setManualKey] = useState(0)
  const [scannedQuery, setScannedQuery] = useState<string>()
  // Manual add is a separate view of the same page. `workId` is "refine the edition" of an existing work.
  const presetWorkId = parameters.get('workId')
  const manualMode = parameters.get('mode') === 'manual' || presetWorkId !== null

  // `page`/`pageSize` is garbage: show the first page and fix the address (`replace`), in either mode.
  const addressValid = address.valid

  useEffect(() => {
    if (!addressValid && address.q !== '') {
      router.replace(
        searchHref(ADD_BOOK_PATH, parameters, {
          q: address.q,
          page: 1,
          pageSize: DEFAULT_SEARCH_PAGE_SIZE,
        }),
      )
    }
  }, [addressValid, address.q, parameters, router])

  if (manualMode) {
    return (
      <AddBookManualScreen
        quick={quick}
        presetWorkId={presetWorkId}
        manualKey={manualKey}
        onAddAnother={() => {
          setManualKey((key) => key + 1)
        }}
      />
    )
  }

  return (
    <AddBookSearchScreen
      quick={quick}
      scannedQuery={scannedQuery}
      onScannedChange={setScannedQuery}
    />
  )
}
