'use client'

import Link from 'next/link'
import type { WorkHolderGroup } from '@bookswap/shared'
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
          <div key={group.translationId ?? `${group.textKind}:${group.language ?? ''}`}>
            <h3>{holderGroupTitle(group)}</h3>
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

/**
 * Заголовок групи: оригінал, переклад чи видання з невідомим текстом. «Немає зв'язку з перекладом» не
 * видається за «оригінал» — це лише `textKind = ORIGINAL`.
 */
function holderGroupTitle(group: WorkHolderGroup): string {
  const language = group.language === null ? '' : ` (${group.language})`

  if (group.textKind === 'ORIGINAL') return `Оригінал${language}`
  if (group.textKind === 'UNKNOWN') return `Оригінал чи переклад — невідомо${language}`

  return `${group.language ?? 'мова невідома'} · ${group.translator ?? 'перекладач невідомий'}`
}
