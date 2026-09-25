'use client'

import Link from 'next/link'
import { useWorkHolders } from '../model/use-holders'
import { NetworkOwnerCopies } from './NetworkCopyActions'

/** «Хто має цю книжку?» — friends' copies of a work, grouped by translation. */
export function HoldersPanel({ workId }: { workId: string }) {
  const { state, reload } = useWorkHolders(workId)

  return (
    <section className="friends-section">
      <h2>Хто має цю книжку?</h2>

      {state.status === 'loading' && <p className="status status--pending">Шукаю серед друзів…</p>}

      {state.status === 'error' && (
        <div role="alert">
          <p className="status status--error">{state.message}</p>
          <button type="button" onClick={() => void reload()}>
            Спробувати ще раз
          </button>
        </div>
      )}

      {state.status === 'ready' && state.data.groups.length === 0 && (
        <p className="empty">
          У ваших друзів цієї книжки немає. <Link href="/friends">Запросити друзів</Link>
        </p>
      )}

      {state.status === 'ready' &&
        state.data.groups.map((group) => (
          <div key={group.translationId ?? 'original'}>
            <h3>
              {group.translationId === null
                ? `Оригінал (${group.language})`
                : `${group.language} · ${group.translator ?? 'перекладач невідомий'}`}
            </h3>
            <ul className="book__locations">
              {group.owners.map((owner) => (
                <li key={owner.owner.id}>
                  <Link href={`/users/${encodeURIComponent(owner.owner.id)}/library`}>
                    {owner.owner.displayName}
                  </Link>{' '}
                  · доступних примірників: {owner.availableCopies}
                  <NetworkOwnerCopies owner={owner} onRequested={reload} />
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  )
}
