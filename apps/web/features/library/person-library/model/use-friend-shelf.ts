'use client'

import { useState } from 'react'
import type { VisibleLibraryResponse } from '@bookswap/shared'
import { displayDecision } from '@/app/lib/resource-state'
import { useFriendLibrary } from '@/app/lib/use-library'

/**
 * Another person's shelf (§6.5), kept on screen while it is read again. `useFriendLibrary` reports
 * every re-read as `loading`; a shelf drawn straight from that would unmount on the re-read a sent
 * request asks for — and with it the request's form and its «Запит надіслано». The last shelf of
 * THIS person stays until the fresh one arrives; another person's is never shown under this one.
 *
 * The remembered shelf is adjusted during render (React's "derive state from props" pattern): an
 * effect would paint one frame of «Завантажую…» first.
 */
export function useFriendShelf(ownerId: string) {
  const { state, reload } = useFriendLibrary(ownerId)
  const [last, setLast] = useState<{ ownerId: string; shelf: VisibleLibraryResponse }>()

  if (state.status === 'ready' && last?.shelf !== state.data)
    setLast({ ownerId, shelf: state.data })

  const { data, backgroundErrorMessage } = displayDecision(
    state,
    last?.ownerId === ownerId ? last.shelf : undefined,
  )

  return { state, shelf: data, backgroundErrorMessage, reload }
}
