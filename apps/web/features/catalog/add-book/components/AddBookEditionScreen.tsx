'use client'

import type {
  Edition,
  EditionPatchRequest,
  WorkDetailResponse,
  WorkPatchRequest,
} from '@bookswap/shared'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useId, useState } from 'react'
import { useWork, type WorkReloadOutcome } from '@/app/lib/use-catalog'
import { FormStatus } from '@/components/Form/FormStatus'
import { cn } from '@/lib/utils'
import {
  EditionCorrectionForm,
  WorkCorrectionForm,
  patchEdition,
  patchWork,
  useCatalogCorrection,
  type WorkCorrectionEntity,
} from '@/features/catalog/correction/index.client'
import { editionRefineFacts } from '../model/edition-refine-view'
import { isOwned } from '../model/quick-add-card'
import { identitiesOf } from '../model/quick-add-identities'
import { backToSearchHref } from '../model/search-address-urls'
import type { QuickAddApi } from '../model/use-quick-add'
import { FactList } from './AddResultDialog'
import { QuickAddActions } from './QuickAddActions'
import { ghostButtonClass, ledeClass, pageClass, pendingStatusClass } from './screen-styles'

type AddBookEditionScreenProps = {
  quick: QuickAddApi
  editionId: string
  workId: string
  /** This screen's key: its confirmed add opens the library while it is still on screen. */
  screen: string | undefined
}

/**
 * «Уточнити дані» of an edition that is already in the catalog (BS-114). Adding creates only the person's
 * copy of THIS edition — never a second work, author or edition. Shared metadata changes only through
 * the catalog's own corrections, each an explicit save with its permission, revision and audit.
 */
export function AddBookEditionScreen({
  quick,
  editionId,
  workId,
  screen,
}: AddBookEditionScreenProps) {
  const parameters = useSearchParams()
  const { state, reload } = useWork(workId)
  const edition =
    state.status === 'ready'
      ? state.detail.editions.find((candidate) => candidate.id === editionId)
      : undefined

  return (
    <main className={pageClass}>
      <h1>Уточнити дані</h1>
      <p className={ledeClass}>Перевірте дані книжки перед додаванням до бібліотеки.</p>
      <p className="mb-8">
        <Link href={backToSearchHref(parameters)} className="link-underline">
          ← До пошуку
        </Link>
      </p>

      {state.status === 'loading' && <p className={pendingStatusClass}>Читаю видання…</p>}
      {state.status === 'error' && <FormStatus error={new Error(state.message)} />}
      {state.status === 'ready' && edition === undefined && (
        <FormStatus
          error={new Error('Цього видання вже немає в каталозі. Поверніться до пошуку.')}
        />
      )}
      {state.status === 'ready' && edition !== undefined && (
        <EditionRefineForm
          detail={state.detail}
          edition={edition}
          reload={reload}
          quick={quick}
          screen={screen}
        />
      )}
    </main>
  )
}

type EditionRefineFormProps = {
  detail: WorkDetailResponse
  edition: Edition
  reload: () => Promise<WorkReloadOutcome>
  quick: QuickAddApi
  screen: string | undefined
}

/**
 * Below the loading guard: the corrections need a known work and edition. They are owned here, not by
 * the closable forms, so a confirmed save keeps showing after its form closes (as on the work page).
 */
function EditionRefineForm({
  detail,
  edition: freshEdition,
  reload,
  quick,
  screen,
}: EditionRefineFormProps) {
  const workCorrection = useCatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>({
    mutationKey: ['work-patch', detail.work.id],
    mutationFn: (body) => patchWork(detail.work.id, body),
    reload,
    revisionOf: (entity) => entity.work.revision,
    entityId: detail.work.id,
  })
  const editionCorrection = useCatalogCorrection<EditionPatchRequest, Edition>({
    mutationKey: ['edition-patch', freshEdition.id],
    mutationFn: (body) => patchEdition(freshEdition.id, body),
    reload,
    revisionOf: (entity) => entity.revision,
    entityId: freshEdition.id,
  })
  const { work, authors } = workCorrection.resolve({ work: detail.work, authors: detail.authors })
  const edition = editionCorrection.resolve(freshEdition)
  const [correcting, setCorrecting] = useState<'work' | 'edition'>()
  const headingId = useId()
  // The same slot as the edition's card on the search: one state, one operation, wherever it is pressed.
  const identities = identitiesOf({ edition: freshEdition })
  const slot = quick.slotFor(identities)
  const facts = editionRefineFacts(work, authors, edition)
  const canEditWork = detail.viewerCapabilities?.canEditWork === true
  const canEditEdition = detail.viewerCapabilities?.editableEditionIds.includes(edition.id) === true
  // An open correction may hold unsaved input: the add would leave the page and lose it silently.
  const blocked = correcting !== undefined || workCorrection.isSaving || editionCorrection.isSaving
  // The other way round too: while this add is in flight or unresolved, its success may still open the
  // library, so no correction may start — its draft would be lost the same way. A rejection frees it.
  const adding = slot?.status === 'pending' || slot?.status === 'unknown'
  const addingHintId = `${headingId}-adding`

  function startCorrecting(which: 'work' | 'edition'): void {
    if (!adding) setCorrecting(which)
  }

  return (
    <>
      <p className="alert alert--warn">
        Це видання вже є в каталозі BookSwap. «Додати до бібліотеки» додасть лише ваш примірник
        цього видання.
        {(canEditWork || canEditEdition) &&
          ' Виправлення даних твору чи видання змінюють спільний каталог — їх побачить кожен, хто відкриє цю книжку.'}
      </p>

      <section className="mb-8 grid gap-3" aria-labelledby={`${headingId}-work`}>
        <h2 id={`${headingId}-work`} className="m-0">
          Твір
        </h2>
        {correcting === 'work' ? (
          <WorkCorrectionForm
            work={work}
            authors={authors}
            correction={workCorrection}
            reload={reload}
            onClose={() => {
              setCorrecting(undefined)
            }}
          />
        ) : (
          <FactList facts={facts.work} />
        )}
        {canEditWork && correcting === undefined && (
          <CorrectButton
            label="Виправити дані твору"
            isLocked={adding}
            lockedHintId={addingHintId}
            onClick={() => {
              startCorrecting('work')
            }}
          />
        )}
      </section>

      <section className="mb-8 grid gap-3" aria-labelledby={`${headingId}-edition`}>
        <h2 id={`${headingId}-edition`} className="m-0">
          Видання
        </h2>
        {correcting === 'edition' ? (
          <EditionCorrectionForm
            edition={edition}
            translations={detail.translations}
            correction={editionCorrection}
            reload={reload}
            onClose={() => {
              setCorrecting(undefined)
            }}
          />
        ) : (
          <FactList facts={facts.edition} />
        )}
        {canEditEdition && correcting === undefined && (
          <CorrectButton
            label="Виправити дані видання"
            isLocked={adding}
            lockedHintId={addingHintId}
            onClick={() => {
              startCorrecting('edition')
            }}
          />
        )}
      </section>

      {adding && (canEditWork || canEditEdition) && (
        <p id={addingHintId} className="form__aside">
          Виправлення недоступні, поки не завершиться додавання.
        </p>
      )}
      {blocked && (
        <p className="form__aside">Щоб додати книжку, спершу збережіть або закрийте виправлення.</p>
      )}
      <QuickAddActions
        slot={slot}
        owned={isOwned(slot, undefined)}
        isBlocked={blocked}
        onAdd={(additional) => {
          quick.add({
            identities,
            entryMethod: 'MANUAL',
            target: { kind: 'EXISTING_EDITION', editionId: freshEdition.id },
            additional,
            ...(screen === undefined ? {} : { screen }),
          })
        }}
        onRetry={() => {
          quick.retry(identities)
        }}
      />
    </>
  )
}

type CorrectButtonProps = {
  label: string
  /** An add of this edition is in flight or unresolved: the button stays focusable but opens nothing. */
  isLocked: boolean
  /** The note that says why, read with the button while it is locked. */
  lockedHintId: string
  onClick: () => void
}

function CorrectButton({ label, isLocked, lockedHintId, onClick }: CorrectButtonProps) {
  return (
    <p className="m-0">
      <button
        type="button"
        data-ui="button"
        className={cn(
          ghostButtonClass,
          'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
        )}
        aria-disabled={isLocked}
        {...(isLocked ? { 'aria-describedby': lockedHintId } : {})}
        onClick={onClick}
      >
        {label}
      </button>
    </p>
  )
}
