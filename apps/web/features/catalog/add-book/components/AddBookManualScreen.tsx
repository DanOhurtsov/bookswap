'use client'

import { workDetailResponseSchema } from '@bookswap/shared'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { apiRequest } from '@/app/lib/api'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { useKeyedRequest } from '@/app/lib/use-keyed-request'
import { FormStatus } from '@/components/Form/FormStatus'
import { manualInitialFrom } from '../model/manual-form'
import { backToSearchHref } from '../model/search-address-urls'
import type { QuickAddApi } from '../model/use-quick-add'
import { ManualAddForm } from './ManualAddForm'
import { ledeClass, pageClass, pendingStatusClass } from './screen-styles'

type AddBookManualScreenProps = {
  quick: QuickAddApi
  /** `workId` of the address: "refine the edition" of an existing work, whose title is then fixed. */
  presetWorkId: string | null
  /**
   * This form's intent (`manualIntentOf`): its add slot, its draft's key and its screen key at once — a
   * confirmed add opens the library only while this very form is on screen.
   */
  intent: string
  onAddAnother: () => void
}

/** The manual form: a separate view of the same page. */
export function AddBookManualScreen({
  quick,
  presetWorkId,
  intent,
  onAddAnother,
}: AddBookManualScreenProps) {
  const parameters = useSearchParams()
  const presetWork = useKeyedRequest(
    presetWorkId !== null ? `work:${presetWorkId}` : undefined,
    (signal) =>
      apiRequest(`/works/${encodeURIComponent(presetWorkId ?? '')}`, {
        schema: workDetailResponseSchema,
        signal,
      }),
  )
  const identities = [intent]
  const presetTitle = presetWork.status === 'ready' ? presetWork.value.work.title : undefined
  const waitingForWork = presetWorkId !== null && presetWork.status !== 'ready'

  return (
    <main className={pageClass}>
      <h1>Додати книжку вручну</h1>
      <p className={ledeClass}>
        Обов’язкова лише назва. Решту можна не знати — її можна уточнити пізніше.
      </p>
      <p className="mb-8">
        <Link href={backToSearchHref(parameters)} className="link-underline">
          ← До пошуку
        </Link>
      </p>

      {presetWork.status === 'error' && (
        <FormStatus error={describeAddBookError(presetWork.error)} />
      )}
      {waitingForWork && presetWork.status === 'loading' && (
        <p className={pendingStatusClass}>Читаю твір…</p>
      )}

      {!waitingForWork && (
        <ManualAddForm
          // Another form is another draft: nothing typed for one intent is shown under another.
          key={intent}
          initial={manualInitialFrom(parameters)}
          {...(presetWorkId !== null && presetTitle !== undefined
            ? { presetWork: { id: presetWorkId, title: presetTitle } }
            : {})}
          slot={quick.slotFor(identities)}
          onSubmit={(target) => {
            quick.add({ identities, entryMethod: 'MANUAL', target, screen: intent })
          }}
          onRetry={() => {
            quick.retry(identities)
          }}
          onUseExistingEdition={(editionId) => {
            quick.add({
              identities,
              entryMethod: 'MANUAL',
              target: { kind: 'EXISTING_EDITION', editionId },
              screen: intent,
            })
          }}
          onAddAnother={onAddAnother}
        />
      )}
    </main>
  )
}
