'use client'

import {
  CONDITION,
  VISIBILITY,
  copyResponseSchema,
  updateCopyRequestSchema,
  type Condition,
  type QuickAddResponse,
  type Visibility,
} from '@bookswap/shared'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { CONDITION_LABELS, VISIBILITY_LABELS } from '@/app/lib/labels'
import { useMediaQuery } from '@/app/lib/use-media-query'
import { BookCover } from '@/components/BookCover'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SelectField, TextAreaField, TextField } from '@/components/Form/FormFields'
import { FormStatus } from '@/components/Form/FormStatus'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { describeEffectiveVisibility } from '../model/effective-visibility'

type CopySettingsSheetProps = {
  open: boolean
  /** Примірник, який налаштовується: уже збережений, тож закриття панелі його не скасовує. */
  added: QuickAddResponse
  /** Видимість бібліотеки користувача: суворіша за видимість примірника, діє першою (§9). */
  libraryVisibility: Visibility
  onClose: () => void
}

interface Values {
  condition: Condition
  visibility: Visibility
  note: string
  acquiredAt: string
}

function initialValues(added: QuickAddResponse): Values {
  const { copy } = added

  return {
    condition: copy.condition,
    visibility: copy.visibility,
    note: copy.note ?? '',
    acquiredAt: copy.acquiredAt ?? '',
  }
}

function sameValues(one: Values, other: Values): boolean {
  return (
    one.condition === other.condition &&
    one.visibility === other.visibility &&
    one.note === other.note &&
    one.acquiredAt === other.acquiredAt
  )
}

/**
 * Налаштування щойно доданого примірника (docs/plan/fast-book-add.md, §2.3).
 *
 * Примірник уже збережений сервером, тож панель необов'язкова: закриття нічого не скасовує. Справа
 * (~440px) на широкому екрані, знизу на вузькому. Фокус-трап, Escape і повернення фокуса дає
 * `Sheet`; незбережений ввід перед закриттям підтверджується `ConfirmDialog`.
 *
 * Особисті поля (стан, видимість, нотатка, дата) зберігаються чинним `PATCH /me/library/:copyId`.
 * Спільні дані книжки редагуються окремою дією — на сторінці твору, зі своїми правами, аудитом і
 * перевіркою ревізії, — а не тут.
 */
export function CopySettingsSheet({
  open,
  added,
  libraryVisibility,
  onClose,
}: CopySettingsSheetProps) {
  const router = useRouter()
  const wide = useMediaQuery('(min-width: 768px)')
  const [baseline, setBaseline] = useState(() => initialValues(added))
  const [values, setValues] = useState(baseline)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  const [saved, setSaved] = useState(false)
  const [fieldError, setFieldError] = useState<string>()
  // Дія, яку треба виконати після підтвердження відмови від незбережених змін.
  const [pendingExit, setPendingExit] = useState<() => void>()

  const dirty = !sameValues(values, baseline)
  const { work, edition, authors } = added

  function change<K extends keyof Values>(key: K, value: Values[K]): void {
    setValues((current) => ({ ...current, [key]: value }))
    setSaved(false)
    setFieldError(undefined)
  }

  /** Закрити або піти геть, але не втрачаючи мовчки введене. */
  function leave(action: () => void): void {
    if (dirty) setPendingExit(() => action)
    else action()
  }

  async function save(): Promise<void> {
    if (saving) return

    const request = {
      condition: values.condition,
      visibility: values.visibility,
      note: values.note.trim() === '' ? null : values.note.trim(),
      acquiredAt: values.acquiredAt === '' ? null : values.acquiredAt,
    }
    const parsed = updateCopyRequestSchema.safeParse(request)

    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Перевірте введені значення')

      return
    }

    setSaving(true)
    setFailure(undefined)
    setSaved(false)

    try {
      await apiRequest(`/me/library/${encodeURIComponent(added.copy.id)}`, {
        method: 'PATCH',
        body: parsed.data,
        schema: copyResponseSchema,
      })
      setBaseline(values)
      setSaved(true)
    } catch (error) {
      // Помилка не закриває панель і не скидає введений текст.
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) leave(onClose)
      }}
    >
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        closeLabel="Закрити налаштування"
        className={wide ? 'sm:max-w-[440px]' : 'max-h-[85vh] overflow-y-auto'}
      >
        <SheetHeader>
          <SheetTitle>Мій примірник</SheetTitle>
          <SheetDescription>Книжка вже у вашій бібліотеці.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4">
          <div className="book lookup-card">
            <BookCover url={edition.coverUrl} alt={`Обкладинка «${work.title}»`} />
            <div className="lookup-card__content">
              <span className="book__title">{work.title}</span>
              {authors.length > 0 && <span>{authors.map((author) => author.name).join(', ')}</span>}
            </div>
          </div>

          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
            noValidate
          >
            <FormStatus error={failure} {...(saved ? { success: 'Зміни збережено.' } : {})} />

            <SelectField
              id="settings-condition"
              label="Стан примірника"
              value={values.condition}
              onChange={(event) => {
                change('condition', event.target.value as Condition)
              }}
            >
              {CONDITION.map((value) => (
                <option key={value} value={value}>
                  {CONDITION_LABELS[value]}
                </option>
              ))}
            </SelectField>

            <SelectField
              id="settings-visibility"
              label="Кому показувати"
              hint={describeEffectiveVisibility(libraryVisibility, values.visibility)}
              value={values.visibility}
              onChange={(event) => {
                change('visibility', event.target.value as Visibility)
              }}
            >
              {VISIBILITY.map((value) => (
                <option key={value} value={value}>
                  {VISIBILITY_LABELS[value]}
                </option>
              ))}
            </SelectField>

            <TextAreaField
              id="settings-note"
              label="Приватна нотатка"
              hint="Видно лише вам."
              value={values.note}
              onChange={(event) => {
                change('note', event.target.value)
              }}
            />

            <details>
              <summary>Додатково</summary>
              <TextField
                id="settings-acquired"
                label="Коли зʼявилася"
                type="date"
                value={values.acquiredAt}
                onChange={(event) => {
                  change('acquiredAt', event.target.value)
                }}
              />
            </details>

            {fieldError !== undefined && (
              <p className="field__error" role="alert">
                {fieldError}
              </p>
            )}

            <button type="submit" aria-disabled={saving} disabled={!dirty && !saving}>
              {saving ? 'Зберігаю…' : 'Зберегти зміни'}
            </button>
          </form>

          <section aria-labelledby="settings-catalog-heading">
            <h3 id="settings-catalog-heading" className="text-sm font-medium">
              Дані книжки
            </h3>
            <p className="field__hint">
              Назва, автори й видавничі дані спільні для всіх: їхні зміни бачать усі, а правила
              редагування й історія змін діють так само, як у каталозі.
            </p>
            <a
              href={`/works/${work.id}`}
              onClick={(event) => {
                event.preventDefault()
                leave(() => {
                  router.push(`/works/${work.id}`)
                })
              }}
            >
              Уточнити
            </a>
          </section>
        </div>

        {/* Усередині `SheetContent`: модальний `Sheet` робить усе поза собою інертним, і діалог поза ним був би недоступний. */}
        <ConfirmDialog
          open={pendingExit !== undefined}
          title="Закрити без збереження?"
          description="Введені зміни примірника не збережені. Сам примірник уже в бібліотеці."
          confirmLabel="Закрити без збереження"
          onConfirm={() => {
            const exit = pendingExit

            setPendingExit(undefined)
            exit?.()
          }}
          onCancel={() => {
            setPendingExit(undefined)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
