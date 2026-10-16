'use client'

import { VISIBILITY } from '@bookswap/shared'
import { useId } from 'react'
import { VISIBILITY_LABELS } from '@/app/lib/labels'
import { SelectField, labelledOptions } from '@/components/Form/FormFields'
import type { CopyVisibilityDraft } from '../model/use-copy-visibility-draft'

const VISIBILITY_OPTIONS = labelledOptions(VISIBILITY, VISIBILITY_LABELS)

type CopyVisibilitySectionProps = {
  visibility: CopyVisibilityDraft
  className?: string
}

/**
 * «Ваш примірник» of a full add form (BS-79): who sees the new copy. The choice belongs to this copy only;
 * the profile's library visibility is never changed from here.
 */
export function CopyVisibilitySection({ visibility, className }: CopyVisibilitySectionProps) {
  const id = useId()

  return (
    <section className={className} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="m-0 mb-3">
        Ваш примірник
      </h2>
      <SelectField
        id={`${id}-visibility`}
        label="Кому показувати"
        hint="Лише для цього примірника. Видимість бібліотеки в профілі не зміниться."
        value={visibility.value}
        options={VISIBILITY_OPTIONS}
        placeholder="За налаштуваннями бібліотеки"
        disabled={visibility.isLocked}
        onValueChange={visibility.change}
      />
    </section>
  )
}
