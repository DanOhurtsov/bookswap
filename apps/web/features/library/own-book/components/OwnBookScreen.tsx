'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { BookCover } from '@/components/BookCover'
import { FormStatus } from '@/components/Form/FormStatus'
import { ReadingStatusPanel } from '@/features/reading-status/index.client'
import { useSession } from '@/app/lib/use-session'
import { toOwnBookView } from '../model/own-book-view'
import { useOwnBook } from '../model/use-own-book'
import { NoteSection } from './NoteSection'

function Shell({ children }: { children: ReactNode }) {
  return <main className="page">{children}</main>
}

/**
 * `/library/:entryId`: the signed-in owner's page of ONE copy. The guard lives here and the data
 * below it (`OwnBookContent`), so nothing asks for the owner's copy before there is an owner.
 */
export function OwnBookScreen({ entryId }: { entryId: string }) {
  const router = useRouter()
  const { state: session, reload: reloadSession } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Завантажую…</p>
      </Shell>
    )
  }

  // A failed session check is not "you are signed out": only `guest` redirects.
  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
        <p className="form__aside">
          <button type="button" onClick={reloadSession}>
            Спробувати ще раз
          </button>{' '}
          · <Link href="/login">Увійти</Link>
        </p>
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  // Keyed by owner: another account on the same tab is another page, not a transition of this one.
  return <OwnBookContent key={session.user.id} entryId={entryId} />
}

function OwnBookContent({ entryId }: { entryId: string }) {
  const { state, retry, noteSave } = useOwnBook(entryId)

  if (state.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Завантажую книжку…</p>
      </Shell>
    )
  }

  if (state.status === 'not-found') {
    return (
      <Shell>
        <h1>Книжку не знайдено</h1>
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <Link href="/library">До моєї бібліотеки</Link>
        </p>
      </Shell>
    )
  }

  if (state.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <button type="button" onClick={retry}>
            Спробувати ще раз
          </button>{' '}
          · <Link href="/library">До моєї бібліотеки</Link>
        </p>
      </Shell>
    )
  }

  const view = toOwnBookView(state.data)

  return (
    <Shell>
      <p className="form__aside">
        <Link href="/library">← До моєї бібліотеки</Link>
      </p>

      <h1>{view.title}</h1>
      <BookCover url={view.edition.coverUrl} alt={`Обкладинка «${view.title}»`} />
      <AuthorLine authors={view.authors} />
      <EditionLine edition={view.edition} />

      <section className="friends-section">
        <h2>Мій примірник</h2>
        <p>{view.statusLabel}</p>
        {view.holderLabel !== null && <p className="book__meta">{view.holderLabel}</p>}
        <p className="book__meta">
          {view.conditionLabel} · {view.visibilityLabel}
        </p>
        {view.acquiredLabel !== null && (
          <p className="book__meta">Придбано: {view.acquiredLabel}</p>
        )}
      </section>

      <NoteSection note={view.note} noteSave={noteSave} />

      <ReadingStatusPanel workId={view.workId} />

      <p className="form__aside">
        <Link href={view.workHref}>Загальна сторінка книги</Link>
      </p>
    </Shell>
  )
}
