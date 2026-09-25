'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import type { VisibleCopy, VisibleLibraryGroup } from '@bookswap/shared'
import { AuthorLine, EditionLine } from '@/components/BookParts'
import { RequestCopyForm } from '@/components/RequestCopyForm'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../../../lib/api'
import { CONDITION_LABELS, COPY_STATUS_LABELS, formatDate } from '../../../../lib/labels'
import { useFriendLibrary } from '../../../../lib/use-library'
import { useSession } from '../../../../lib/use-session'

/**
 * §6.5: бібліотека іншої людини.
 *
 * Сторінка нічого не приховує сама — вона показує рівно те, що приїхало. Рішення
 * «що видно» ухвалює API за матрицею §9, і приватних полів у відповіді просто
 * немає. Фільтрувати їх тут було б другою реалізацією тих самих правил, яка
 * одного дня розійдеться з першою.
 *
 * Кнопка «Попросити» (§5.1) дивиться на `myActiveLoan`, а НЕ на `Copy.status`:
 * створення запиту примірника не змінює, тож після надісланого прохання книжка
 * лишається `AVAILABLE`. Рішення за статусом дозволило б натиснути вдруге й
 * отримати 409 — помилку, яку клієнт мав знати наперед.
 */
export default function FriendLibraryPage() {
  const parameters = useParams<{ id: string }>()
  const router = useRouter()
  const { state: session, reload: reloadSession } = useSession()
  const { state, reload } = useFriendLibrary(parameters.id)
  const [failure, setFailure] = useState<unknown>()
  const [busyKey, setBusyKey] = useState<string>()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  async function requestCopy(copyId: string, body: Record<string, unknown>): Promise<void> {
    setFailure(undefined)
    setBusyKey(`request:${copyId}`)

    try {
      await apiRequest('/loans', { method: 'POST', body: { copyId, ...body } })
      // `await`: доки не приїхав оновлений список із `canRequest: false`, кнопка
      // лишається заблокованою — інакше другий клік дав би 409.
      await reload()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusyKey(undefined)
    }
  }

  if (session.status === 'loading' || state.status === 'loading') {
    return (
      <Shell title="Бібліотека">
        <p className="status status--pending">Завантажую…</p>
      </Shell>
    )
  }

  // Збій перевірки сесії — це НЕ «ви не залогінені»: редирект робиться лише для
  // `guest`. Показати тут «Переадресовую…» означало б лишити людину перед
  // написом, який ніколи не справдиться.
  if (session.status === 'error') {
    return (
      <Shell title="Бібліотека">
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
      <Shell title="Бібліотека">
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  if (state.status === 'error') {
    return (
      <Shell title="Бібліотека">
        <FormStatus error={new Error(state.message)} />
        <p className="form__aside">
          <Link href="/friends">До друзів</Link>
        </p>
      </Shell>
    )
  }

  return (
    <Shell title={`Бібліотека: ${state.data.owner.displayName}`}>
      <FormStatus error={failure} />

      {state.data.groups.length === 0 ? (
        <p className="empty">Тут поки нічого не видно.</p>
      ) : (
        <ul className="books">
          {state.data.groups.map((group) => (
            <GroupCard
              key={group.edition.id}
              group={group}
              busyKey={busyKey}
              onRequest={requestCopy}
            />
          ))}
        </ul>
      )}

      <p className="form__aside">
        <Link href="/friends">До друзів</Link> · <Link href="/loans">Позичання</Link> ·{' '}
        <Link href="/catalog">Каталог</Link> · <Link href="/library">Моя бібліотека</Link>
      </p>
    </Shell>
  )
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      {children}
    </main>
  )
}

function GroupCard({
  group,
  busyKey,
  onRequest,
}: {
  group: VisibleLibraryGroup
  busyKey: string | undefined
  onRequest: (copyId: string, body: Record<string, unknown>) => Promise<void>
}) {
  return (
    <li className="book">
      <Link className="book__title" href={`/works/${group.work.id}`}>
        {group.work.title}
        {group.counts.total > 1 && ` ×${String(group.counts.total)}`}
      </Link>
      {/* §6.5: позначка з вішлиста — лише прапорець, без дій тут. Прибрати чи
          додати можна на сторінці твору (`WishlistButton`), де є й `authors`
          для оптимістичного додавання. */}
      {group.inWishlist && <span className="badge">У вішлисті</span>}
      <AuthorLine authors={group.authors} />
      <EditionLine edition={group.edition} />

      <ul className="copies">
        {group.copies.map((copy) => (
          <li className="copy" key={copy.id}>
            <span className="book__meta">
              {COPY_STATUS_LABELS[copy.status]} · {CONDITION_LABELS[copy.condition]}
              {/* §6.6: імʼя тримача показується лише коли власник це дозволив;
                  інакше приїжджає null, і видно самий статус. */}
              {!copy.isHome &&
                (copy.holder === null ? ' · зараз у когось' : ` · у ${copy.holder.displayName}`)}
              {/* §6.5: «Для RESERVED / LENT_OUT — орієнтовна дата повернення,
                  якщо власник її вказав». Дата приходить окремим полем і не
                  залежить від showHolderNames: вона про книжку, а не про людину. */}
              {copy.expectedReturnAt !== null &&
                ` · орієнтовно вільна ${formatDate(copy.expectedReturnAt)}`}
            </span>

            <CopyAction copy={copy} busyKey={busyKey} onRequest={onRequest} />
          </li>
        ))}
      </ul>
    </li>
  )
}

/**
 * Що можна зробити з цим примірником просто зараз.
 *
 * Порядок гілок значущий: **спершу власний лоан**, і лише потім статус
 * примірника. Зворотний порядок — рівно та помилка, від якої рятує `myActiveLoan`:
 * після надісланого запиту книжка ще `AVAILABLE`, і кнопка «Попросити»
 * зʼявилася б удруге.
 */
function CopyAction({
  copy,
  busyKey,
  onRequest,
}: {
  copy: VisibleCopy
  busyKey: string | undefined
  onRequest: (copyId: string, body: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const busy = busyKey !== undefined

  if (copy.myActiveLoan !== null) {
    // Глибоке посилання веде до КОНКРЕТНОГО лоану, а не до списку, у якому його
    // ще треба знайти. `role=borrower` — бік глядача: тут він завжди той, хто
    // просить, бо це чужа полиця.
    const loanHref = `/loans?loanId=${copy.myActiveLoan.id}&role=borrower`

    switch (copy.myActiveLoan.status) {
      case 'REQUESTED':
        return (
          <span className="book__meta">
            Запит надіслано — чекайте на відповідь. <Link href={loanHref}>Відкрити запит</Link>
          </span>
        )
      case 'APPROVED':
        return (
          <span className="book__meta">
            Домовлено. Коли отримаєте книжку — підтвердьте це в{' '}
            <Link href={loanHref}>позичанні</Link>.
          </span>
        )
      case 'HANDED_OVER':
        return (
          <span className="book__meta">
            Ця книжка зараз у вас. <Link href={loanHref}>Відкрити позичання</Link> ·{' '}
            <Link href="/library">Чужі в мене</Link>
          </span>
        )
    }
  }

  // §6.5 і §9: капабіліті рахує сервер. Тут навмисно НЕМА перевірки статусу,
  // дружби чи видимості — це були б другі реалізації авторизаційних правил, до
  // того ж без даних, потрібних, щоб відповісти правильно.
  //
  // Дата повернення тут не повторюється: вона вже стоїть у рядку статусу вище.
  if (!copy.canRequest) {
    return <span className="book__meta">Зараз попросити не можна.</span>
  }

  if (!open) {
    return (
      <div className="person__actions">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(true)
          }}
        >
          Попросити
        </button>
      </div>
    )
  }

  return (
    <RequestCopyForm
      copyId={copy.id}
      busy={busy}
      submitting={busyKey === `request:${copy.id}`}
      onSubmit={(body) => {
        void onRequest(copy.id, body)
      }}
      onCancel={() => {
        setOpen(false)
      }}
    />
  )
}
