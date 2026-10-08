'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ExternalBorrower } from '@bookswap/shared'
import { describeError } from '@/app/lib/api'
import { listContacts } from '../api/contacts-requests'

export type ContactsState =
  | { status: 'loading' }
  | { status: 'ready'; contacts: ExternalBorrower[] }
  | { status: 'error'; message: string }

/** Owner's private contacts. Mounted only while the feature is on, so it never calls the API when off. */
export function useContacts(): {
  state: ContactsState
  reload: () => void
  upsert: (contact: ExternalBorrower) => void
  remove: (contactId: string) => void
} {
  const [state, setState] = useState<ContactsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    listContacts(controller.signal)
      .then(({ contacts }) => {
        if (!controller.signal.aborted) setState({ status: 'ready', contacts })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: describeError(error) })
      })

    return () => {
      controller.abort()
    }
  }, [nonce])

  const reload = useCallback(() => {
    setState({ status: 'loading' })
    setNonce((value) => value + 1)
  }, [])

  const upsert = useCallback((contact: ExternalBorrower) => {
    setState((previous) => {
      if (previous.status !== 'ready') return previous

      const exists = previous.contacts.some((item) => item.id === contact.id)

      return {
        status: 'ready',
        contacts: exists
          ? previous.contacts.map((item) => (item.id === contact.id ? contact : item))
          : [contact, ...previous.contacts],
      }
    })
  }, [])

  /** Item 3 (10f.3 web-рев'ю): успішний DELETE прибирає контакт зі списку одразу, без нового GET. */
  const remove = useCallback((contactId: string) => {
    setState((previous) => {
      if (previous.status !== 'ready') return previous

      return {
        status: 'ready',
        contacts: previous.contacts.filter((item) => item.id !== contactId),
      }
    })
  }, [])

  return { state, reload, upsert, remove }
}
