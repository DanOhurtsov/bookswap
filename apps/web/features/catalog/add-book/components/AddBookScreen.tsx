'use client'

import { DEFAULT_SEARCH_PAGE_SIZE } from '@bookswap/shared'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { readSearchAddress, searchHref } from '@/app/lib/search-page'
import { useSession } from '@/app/lib/use-session'
import {
  ADD_BOOK_PATH,
  addBookModeOf,
  manualIntentOf,
  opensLibraryAfterAdd,
  screenKeyOf,
} from '../model/search-address-urls'
import { useQuickAdd } from '../model/use-quick-add'
import { AddBookEditionScreen } from './AddBookEditionScreen'
import { AddBookManualScreen } from './AddBookManualScreen'
import { AddBookSearchScreen } from './AddBookSearchScreen'
import { pageClass, pendingStatusClass } from './screen-styles'

/**
 * Єдиний вхід у додавання книжки (docs/plan/fast-book-add.md, §2): пошук за назвою, автором або ISBN;
 * сканування лише підставляє ISBN у той самий пошук і нічого не створює.
 *
 * Стан пошуку — запит, сторінка, розмір — живе в адресі (пряме посилання, «назад» і перезавантаження
 * відновлюють список). Додавання з діалогу результату нічого в адресі не змінює: після успіху користувач
 * лишається в тих самих результатах, на тій самій сторінці й позиції прокрутки (BS-114). Успіх повної
 * форми веде до бібліотеки.
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
 * Picks the screen for the address. What must survive a switch between them lives here: the add
 * slots (`quick`), the manual form's intent counter (part of its intent, `manualIntentOf`), and whether the
 * query in the address came from the scanner.
 */
function AddBookModes({ userId }: AddBookModesProps) {
  const router = useRouter()
  const parameters = useSearchParams()
  const address = readSearchAddress(parameters)
  // Manual add and refining an edition are separate views of the same page.
  const mode = addBookModeOf(parameters)
  /** Every new form is a new intent (and a new add slot): after a success the next one can be added. */
  const [manualKey, setManualKey] = useState(0)
  const screen = screenKeyOf(mode, manualKey)
  // Read when an answer arrives — possibly long after the add started, on another screen.
  const screenRef = useRef(screen)
  const quick = useQuickAdd({
    userId,
    onAdded: (_response, startedOn) => {
      if (opensLibraryAfterAdd(startedOn, screenRef.current)) router.push('/library')
    },
  })
  const [scannedQuery, setScannedQuery] = useState<string>()

  useEffect(() => {
    screenRef.current = screen
  })

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

  if (mode.kind === 'edition') {
    return (
      <AddBookEditionScreen
        quick={quick}
        editionId={mode.editionId}
        workId={mode.workId}
        screen={screen}
      />
    )
  }

  if (mode.kind === 'manual') {
    return (
      <AddBookManualScreen
        quick={quick}
        presetWorkId={mode.presetWorkId}
        intent={manualIntentOf(mode.form, manualKey)}
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
