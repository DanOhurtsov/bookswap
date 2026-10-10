'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { useCopyHistory } from '@/app/lib/use-history'
import { useSession } from '@/app/lib/use-session'
import { FormStatus } from '@/components/Form/FormStatus'
import { CONDITION_LABELS, COPY_STATUS_LABELS } from '@/app/lib/labels'
import { HistoryEntryLine } from '@/components/HistoryEntryLine'

/**
 * §6.6: історія примірника — усі його лоани в хронології.
 *
 * Сторінка нічого не приховує сама. Коли §9 не дозволяє бачити імена, вони не
 * приїжджають узагалі — у відповіді немає ані `owner`, ані `borrower`, ані
 * `loanId`. Фільтрувати тут було б другою реалізацією тих самих правил.
 */
export default function CopyHistoryPage() {
  const parameters = useParams<{ id: string }>()
  const router = useRouter()
  const { state: session, reload: reloadSession } = useSession()
  const { state } = useCopyHistory(parameters.id)

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading' || state.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Завантажую…</p>
      </Shell>
    )
  }

  // Збій перевірки сесії — це НЕ «ви не залогінені». Показати тут «Переадресовую…»
  // означало б залишити людину перед написом, який ніколи не справдиться: редирект
  // робиться лише для `guest`, а сюди приводить, наприклад, недоступний API.
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

  if (state.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(state.message)} />
      </Shell>
    )
  }

  const { copy, entries } = state.data

  return (
    <Shell>
      <ul className="books">
        <li className="book">
          <Link className="book__title" href={`/works/${copy.work.id}`}>
            {copy.work.title}
          </Link>
          <AuthorLine authors={copy.authors} />
          <EditionLine edition={copy.edition} />
          <span className="book__meta">
            {COPY_STATUS_LABELS[copy.status]} · {CONDITION_LABELS[copy.condition]}
          </span>

          {entries.length === 0 ? (
            <p className="empty">Цей примірник ще нікуди не їздив.</p>
          ) : (
            <ul className="copies">
              {entries.map((entry, index) => (
                // Анонімний запис не має `loanId` навмисно (§6.6): саме за ним
                // два зрізи чужої історії склеїлися б в одну людину. Тому ключ —
                // позиція в уже впорядкованому сервером списку.
                <HistoryEntryLine
                  key={entry.names ? entry.loanId : `anon-${String(index)}`}
                  entry={entry}
                />
              ))}
            </ul>
          )}
        </li>
      </ul>
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Історія примірника</h1>
      {children}
    </main>
  )
}
