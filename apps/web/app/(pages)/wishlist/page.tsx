'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { AuthorLine } from '@/components/BookParts'
import { FormStatus } from '@/components/Form/FormStatus'
import { useSession } from '../../lib/use-session'
import { useWishlist } from '../../lib/use-wishlist'

/**
 * §6.5 і §8, підетап 7f: сторінка вішлиста — список творів і кнопка «Прибрати»
 * на кожен. Оптимістичне оновлення й відкат при помилці — у `useWishlist`,
 * тут лише малювання.
 */
export default function WishlistPage() {
  const router = useRouter()
  const { state: session } = useSession()
  const wishlist = useWishlist()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
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

  if (wishlist.items === undefined) {
    if (wishlist.state.status === 'error') {
      return (
        <Shell>
          <FormStatus error={new Error(wishlist.state.message)} />
        </Shell>
      )
    }

    return (
      <Shell>
        <p className="status status--pending">Завантажую…</p>
      </Shell>
    )
  }

  return (
    <Shell>
      {wishlist.refreshing && <p className="status status--pending">Оновлюю…</p>}

      {wishlist.backgroundErrorMessage !== undefined && (
        <FormStatus error={new Error(`Не вдалося оновити: ${wishlist.backgroundErrorMessage}`)} />
      )}

      <FormStatus error={wishlist.actionError} />

      {wishlist.items.length === 0 ? (
        <p className="empty">
          Тут поки порожньо. Додайте твір кнопкою «Додати у вішлист» на сторінці книжки.
        </p>
      ) : (
        <ul className="books">
          {wishlist.items.map((item) => (
            <li className="book" key={item.workId}>
              <Link className="book__title" href={`/works/${item.workId}`}>
                {item.work.title}
              </Link>
              <AuthorLine authors={item.authors} />

              <div className="person__actions">
                <button
                  type="button"
                  className="button--danger"
                  disabled={wishlist.isPending(item.workId)}
                  onClick={() => {
                    void wishlist.remove(item.workId)
                  }}
                >
                  {wishlist.isPending(item.workId) ? 'Прибираю…' : 'Прибрати'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Вішлист</h1>
      {children}
    </main>
  )
}
