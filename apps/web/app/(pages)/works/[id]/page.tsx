'use client'

import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import {
  CONDITION,
  VISIBILITY,
  addCopyRequestSchema,
  copyResponseSchema,
  type Condition,
  type Edition,
  type EditionPatchRequest,
  type Translation,
  type TranslationPatchRequest,
  type Visibility,
  type Work,
  type WorkAuthor,
  type WorkPatchRequest,
} from '@bookswap/shared'
import { AuthorLine, Chip, EditionLine } from '@/components/BookParts'
import { HistoryEntryLine } from '@/components/HistoryEntryLine'
import { SelectField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import { WishlistButton } from '@/components/WishList/WishListButton'
import {
  EditionCorrectionForm,
  TranslationCorrectionForm,
  WorkCorrectionForm,
  patchEdition,
  patchTranslation,
  patchWork,
  useCatalogCorrection,
  type CatalogCorrection,
  type WorkCorrectionEntity,
} from '@/features/catalog/correction/index.client'
import { ApiRequestError, apiRequest, describeError } from '../../../lib/api'
import { CONDITION_LABELS, VISIBILITY_LABELS } from '../../../lib/labels'
import { useWork, type WorkReloadOutcome } from '../../../lib/use-catalog'
import { useWorkHistory } from '../../../lib/use-history'
import { useSession } from '../../../lib/use-session'
import { useWishlist } from '../../../lib/use-wishlist'
import { validate, type FieldErrors } from '../../../lib/validation'

/**
 * Сторінка твору: метадані, переклади з ознаками §10.3 і видання.
 *
 * Примірників тут немає — ні своїх, ні друзів. Каталог однаковий для всіх, а хто
 * чим володіє, живе за матрицею §9 у бібліотеках.
 *
 * Знизу — історія твору (§6.6, «хто з моїх це взагалі читав»). Вона відповідає на
 * те саме питання, заради якого §6.5 хотіла позначку «у кого з друзів це є», але
 * чесніше: не «у кого лежить», а «хто справді брав», і без переліку чужих полиць.
 */
export default function WorkPage() {
  const parameters = useParams<{ id: string }>()
  const router = useRouter()
  const { state: session, reload: reloadSession } = useSession()
  const workId = parameters.id
  const { state, reload, canonicalWorkId } = useWork(workId)
  const wishlist = useWishlist()

  // Owned here — not inside the (closable) correction form — so the header
  // and author line below keep showing a confirmed save through a failed
  // refresh or after the form closes (8e-3 follow-up, "overlay lifted to
  // where title/authors/cards read it"). Called unconditionally, before any
  // early return, per the Rules of Hooks: `state.detail` may not exist yet.
  const knownWorkId = state.status === 'ready' ? state.detail.work.id : workId
  const workCorrection = useCatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>({
    mutationKey: ['work-patch', knownWorkId],
    mutationFn: (body) => patchWork(knownWorkId, body),
    reload,
    revisionOf: (entity) => entity.work.revision,
    entityId: knownWorkId,
  })

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  /**
   * §6.3: reading a merged work answers 301 on the canonical one, and `fetch`
   * follows it — so the data below is already right, and only the address bar
   * is stale. Left alone it is the stale part that spreads: the URL people copy
   * out of it, bookmark and paste into chats would keep pointing at a duplicate
   * whose page is empty of everything but a title.
   *
   * `replace`, not `push`: the merged id is not a place worth being able to
   * navigate back to.
   */
  useEffect(() => {
    if (canonicalWorkId !== null) router.replace(`/works/${encodeURIComponent(canonicalWorkId)}`)
  }, [canonicalWorkId, router])

  if (session.status === 'loading' || state.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Завантажую…</p>
      </Shell>
    )
  }

  // Збій перевірки сесії — це НЕ «ви не залогінені»: редирект робиться лише для
  // `guest`, тож «Переадресовую…» тут ніколи б не справдилося.
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
        <p className="form__aside">
          <Link href="/catalog">До каталогу</Link>
        </p>
      </Shell>
    )
  }

  const { translations, editions, viewerCapabilities } = state.detail
  const { work, authors } = workCorrection.resolve({
    work: state.detail.work,
    authors: state.detail.authors,
  })
  const canEditWork = viewerCapabilities?.canEditWork === true

  return (
    <main className="page">
      <h1>{work.title}</h1>
      <p className="lede">
        <AuthorLine authors={authors} />
      </p>

      <WishlistButton work={work} authors={authors} wishlist={wishlist} />

      {canEditWork && (
        <WorkCorrectionSection
          work={work}
          authors={authors}
          correction={workCorrection}
          reload={reload}
        />
      )}

      <dl className="facts">
        <dt>Мова оригіналу</dt>
        <dd>{work.origLang}</dd>
        {work.firstPubYear !== null && (
          <>
            <dt>Перше видання</dt>
            <dd>{work.firstPubYear}</dd>
          </>
        )}
      </dl>

      {work.description !== null && <p>{work.description}</p>}

      <section className="friends-section">
        <h2>Переклади</h2>
        {translations.length === 0 ? (
          <p className="empty">Перекладів не додано — твір є лише мовою оригіналу.</p>
        ) : (
          <ul className="books">
            {translations.map((translation) => (
              <TranslationCard
                key={translation.id}
                translation={translation}
                canEdit={
                  viewerCapabilities?.editableTranslationIds.includes(translation.id) === true
                }
                reload={reload}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="friends-section">
        <h2>Видання</h2>
        {editions.length === 0 ? (
          <p className="empty">Видань ще немає. Додайте своє — і зможете покласти примірник.</p>
        ) : (
          <ul className="books">
            {editions.map((edition) => (
              <EditionCard
                key={edition.id}
                edition={edition}
                translations={translations}
                canEdit={viewerCapabilities?.editableEditionIds.includes(edition.id) === true}
                onAdded={reload}
                reload={reload}
              />
            ))}
          </ul>
        )}
      </section>

      <WorkHistorySection workId={workId} />

      <p className="form__aside">
        <Link href={`/catalog/new?workId=${work.id}`}>Додати переклад або видання</Link> ·{' '}
        <Link href="/catalog">До каталогу</Link> · <Link href="/library">Моя бібліотека</Link> ·{' '}
        <Link href="/wishlist">Вішлист</Link>
      </p>
    </main>
  )
}

/**
 * §6.6: «хто з моїх це взагалі читав».
 *
 * Специфікація називає це кориснішим за історію примірника — і саме тому воно
 * тут, на сторінці твору: питання «чи варто просити цю книжку» ставлять до того,
 * як обрали конкретний том. Обсяг — примірники друзів і свої; чужі сюди не
 * потрапляють, і фільтрує їх сервер за §9.
 */
function WorkHistorySection({ workId }: { workId: string }) {
  const { state } = useWorkHistory(workId)

  if (state.status === 'loading') {
    return (
      <section className="friends-section">
        <h2>Хто з друзів це читав</h2>
        <p className="status status--pending">Завантажую…</p>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section className="friends-section">
        <h2>Хто з друзів це читав</h2>
        <FormStatus error={new Error(state.message)} />
      </section>
    )
  }

  return (
    <section className="friends-section">
      <h2>Хто з друзів це читав</h2>
      {state.data.entries.length === 0 ? (
        <p className="empty">Серед ваших друзів цю книжку ще ніхто не позичав.</p>
      ) : (
        <ul className="copies">
          {state.data.entries.map((item, index) => (
            <HistoryEntryLine
              // Анонімний запис не має `loanId` навмисно (§6.6): за ним два зрізи
              // чужої історії склеїлися б в одну людину.
              key={item.entry.names ? item.entry.loanId : `anon-${String(index)}`}
              entry={item.entry}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 8e-3: correction UI for `viewerCapabilities.canEditWork` (R8/R10). Collapsed
 * by default — most viewers never see this at all, and API stays the actual
 * permission boundary regardless of what this button shows. `correction` is
 * owned by `WorkPage`, not here, so it survives this section toggling closed.
 */
function WorkCorrectionSection({
  work,
  authors,
  correction,
  reload,
}: {
  work: Work
  authors: WorkAuthor[]
  correction: CatalogCorrection<WorkPatchRequest, WorkCorrectionEntity>
  reload: () => Promise<WorkReloadOutcome>
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <p className="form__aside">
        <button type="button" className="button--ghost" onClick={() => setOpen(true)}>
          Виправити метадані твору
        </button>
      </p>
    )
  }

  return (
    <WorkCorrectionForm
      work={work}
      authors={authors}
      correction={correction}
      reload={reload}
      onClose={() => setOpen(false)}
    />
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Твір</h1>
      {children}
    </main>
  )
}

/**
 * §10.3, cold start: числового рангу немає й показувати нема чого, тож видно
 * структуровані ознаки — факти, а не думки. Це навмисно: «краще не показати
 * нічого, ніж показати 5.0 від однієї людини».
 *
 * Owns its own `useCatalogCorrection` instance (not the form) so a confirmed
 * save for THIS translation keeps showing — in the read view below AND after
 * the form closes — even through a failed background refresh.
 */
function TranslationCard({
  translation: freshTranslation,
  canEdit,
  reload,
}: {
  translation: Translation
  canEdit: boolean
  reload: () => Promise<WorkReloadOutcome>
}) {
  const correction = useCatalogCorrection<TranslationPatchRequest, Translation>({
    mutationKey: ['translation-patch', freshTranslation.id],
    mutationFn: (body) => patchTranslation(freshTranslation.id, body),
    reload,
    revisionOf: (entity) => entity.revision,
    entityId: freshTranslation.id,
  })
  const translation = correction.resolve(freshTranslation)
  const [editing, setEditing] = useState(false)

  return (
    <li className="book">
      <span className="book__title">{translation.translator}</span>
      <span className="book__meta">
        {translation.lang} ← {translation.sourceLang}
        {translation.year !== null && ` · ${String(translation.year)}`}
      </span>
      <div className="chips">
        <Chip>{translation.isAbridged ? 'скорочений' : 'повний'}</Chip>
        {translation.hasNotes && <Chip>з примітками</Chip>}
        <Chip>
          {translation.editionCount === 0
            ? 'видань не додано'
            : `видань: ${String(translation.editionCount)}`}
        </Chip>
      </div>
      {translation.notes !== null && <p className="book__meta">{translation.notes}</p>}

      {canEdit &&
        (editing ? (
          <TranslationCorrectionForm
            translation={translation}
            correction={correction}
            reload={reload}
            onClose={() => setEditing(false)}
          />
        ) : (
          <div className="person__actions">
            <button type="button" className="button--ghost" onClick={() => setEditing(true)}>
              Виправити переклад
            </button>
          </div>
        ))}
    </li>
  )
}

/**
 * Owns its own `useCatalogCorrection` instance for the SAME reason as
 * `TranslationCard` — separate from the "Це моє видання" add-copy flow below,
 * which is unrelated catalog-vs-library state.
 */
function EditionCard({
  edition: freshEdition,
  translations,
  canEdit,
  onAdded,
  reload,
}: {
  edition: Edition
  translations: Translation[]
  canEdit: boolean
  onAdded: () => void
  reload: () => Promise<WorkReloadOutcome>
}) {
  const correction = useCatalogCorrection<EditionPatchRequest, Edition>({
    mutationKey: ['edition-patch', freshEdition.id],
    mutationFn: (body) => patchEdition(freshEdition.id, body),
    reload,
    revisionOf: (entity) => entity.revision,
    entityId: freshEdition.id,
  })
  const edition = correction.resolve(freshEdition)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [condition, setCondition] = useState<Condition>('GOOD')
  const [visibility, setVisibility] = useState<Visibility>('FRIENDS')
  const [note, setNote] = useState('')
  const [acquiredAt, setAcquiredAt] = useState('')
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [added, setAdded] = useState<string>()
  const [errors, setErrors] = useState<FieldErrors>({})

  async function submit(): Promise<void> {
    setFailure(undefined)
    setAdded(undefined)

    const result = validate(addCopyRequestSchema, {
      editionId: edition.id,
      condition,
      visibility,
      note: note.trim() === '' ? null : note,
      acquiredAt: acquiredAt === '' ? null : acquiredAt,
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors({})
    setPending(true)

    try {
      await apiRequest('/me/library', {
        method: 'POST',
        body: result.data,
        schema: copyResponseSchema,
      })

      setAdded('Примірник додано до вашої бібліотеки.')
      setOpen(false)
      onAdded()
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setPending(false)
    }
  }

  return (
    <li className="book">
      <EditionLine edition={edition} />

      <FormStatus error={failure} success={added} />

      {open ? (
        <div className="form">
          <SelectField
            id={`condition-${edition.id}`}
            label="Стан примірника"
            value={condition}
            onChange={(event) => {
              setCondition(event.target.value as Condition)
            }}
          >
            {CONDITION.map((value) => (
              <option key={value} value={value}>
                {CONDITION_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <SelectField
            id={`visibility-${edition.id}`}
            label="Кому показувати"
            value={visibility}
            onChange={(event) => {
              setVisibility(event.target.value as Visibility)
            }}
          >
            {VISIBILITY.map((value) => (
              <option key={value} value={value}>
                {VISIBILITY_LABELS[value]}
              </option>
            ))}
          </SelectField>

          <TextField
            id={`note-${edition.id}`}
            label="Нотатка"
            hint="Видно лише вам."
            value={note}
            error={errors.note}
            onChange={(event) => {
              setNote(event.target.value)
            }}
          />

          <TextField
            id={`acquired-${edition.id}`}
            label="Коли зʼявилася"
            type="date"
            value={acquiredAt}
            error={errors.acquiredAt}
            onChange={(event) => {
              setAcquiredAt(event.target.value)
            }}
          />

          <div className="person__actions">
            <button type="button" disabled={pending} onClick={() => void submit()}>
              {pending ? 'Додаю…' : 'Додати примірник'}
            </button>
            <button
              type="button"
              className="button--ghost"
              disabled={pending}
              onClick={() => {
                setOpen(false)
              }}
            >
              Скасувати
            </button>
          </div>
        </div>
      ) : (
        <div className="person__actions">
          <button
            type="button"
            onClick={() => {
              setOpen(true)
              setAdded(undefined)
            }}
          >
            Це моє видання
          </button>
        </div>
      )}

      {canEdit &&
        (editing ? (
          <EditionCorrectionForm
            edition={edition}
            translations={translations}
            correction={correction}
            reload={reload}
            onClose={() => setEditing(false)}
          />
        ) : (
          <div className="person__actions">
            <button type="button" className="button--ghost" onClick={() => setEditing(true)}>
              Виправити видання
            </button>
          </div>
        ))}
    </li>
  )
}
