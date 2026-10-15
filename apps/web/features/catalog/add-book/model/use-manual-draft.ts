'use client'

import type { QuickAddManualTarget } from '@bookswap/shared'
import { useLayoutEffect, useRef, useState } from 'react'
import { manualRevealOf, type ManualSection } from './manual-field-view'
import {
  buildManualTarget,
  manualFieldError,
  type ManualFieldErrors,
  type ManualFieldName,
  type ManualFormValues,
} from './manual-form'

interface FocusRequest {
  name: ManualFieldName
  target: 'control' | 'trigger'
}

/** The part one field's view/editor needs — see `ManualInlineField`. */
export interface ManualEditors {
  isOpen: (name: ManualFieldName) => boolean
  /** Opens the editor and focuses its control. Never touches the draft and sends nothing. */
  open: (name: ManualFieldName) => void
  /** Checks this field by the form's own rules and closes only when it is valid. Never submits. */
  confirm: (name: ManualFieldName) => void
  /** Restores the value from when THIS editor opened; every other field keeps its draft. */
  cancel: (name: ManualFieldName) => void
  registerTrigger: (name: ManualFieldName, element: HTMLElement | null) => void
  registerEditor: (name: ManualFieldName, element: HTMLElement | null) => void
}

export interface ManualDraft extends ManualEditors {
  values: ManualFormValues
  errors: ManualFieldErrors
  change: <K extends ManualFieldName>(key: K, value: ManualFormValues[K]) => void
  isSectionOpen: (section: ManualSection) => boolean
  setSectionOpen: (section: ManualSection, open: boolean) => void
  /**
   * «Додати до бібліотеки»: the target when the whole draft — open editors included — is valid
   * (the editors close: what they hold is the draft). Otherwise `undefined`, and every invalid
   * field opens with its error, inside an opened section, the first one focused.
   */
  submit: () => QuickAddManualTarget | undefined
}

function withField<K extends ManualFieldName>(
  values: ManualFormValues,
  key: K,
  value: ManualFormValues[K],
): ManualFormValues {
  return { ...values, [key]: value }
}

function firstControl(container: HTMLElement | undefined): HTMLElement | undefined {
  // A radio group is entered at its current answer, as Tab would enter it.
  return (
    container?.querySelector<HTMLElement>('input:checked') ??
    container?.querySelector<HTMLElement>('input, select, textarea') ??
    undefined
  )
}

/**
 * The manual form's draft with inline editing (BS-76). Every editor binds straight to `values`, so
 * «Додати до бібліотеки» always sees what an open editor holds; an editor's own «Зберегти» and
 * «Скасувати» are local and never reach the server.
 *
 * One hook owns both the draft and the editors because their invariants cross: a failed submit opens
 * editors and sections, a successful one closes every editor, and «Скасувати» rewrites the draft.
 */
export function useManualDraft(
  initial: ManualFormValues,
  presetWorkId: string | undefined,
): ManualDraft {
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<ManualFieldErrors>({})
  const [openNames, setOpenNames] = useState<ReadonlySet<ManualFieldName>>(() => new Set())
  // A translator already known means the section has content to show.
  const [sections, setSections] = useState<Readonly<Record<ManualSection, boolean>>>(() => ({
    translation: initial.translator !== '',
    extra: false,
  }))
  // What «Скасувати» brings back: the whole draft as it was when that editor opened. The authors'
  // array is copied: today every edit replaces it, but the snapshot must not depend on that.
  const snapshots = useRef(new Map<ManualFieldName, ManualFormValues>())
  const triggers = useRef(new Map<ManualFieldName, HTMLElement>())
  const editors = useRef(new Map<ManualFieldName, HTMLElement>())
  // Consumed by the dep-less layout effect below: the element to focus exists only after the render
  // that mounts it has committed.
  const pendingFocus = useRef<FocusRequest | undefined>(undefined)

  useLayoutEffect(() => {
    const request = pendingFocus.current

    if (request === undefined) return

    const element =
      request.target === 'trigger'
        ? triggers.current.get(request.name)
        : firstControl(editors.current.get(request.name))

    if (element === undefined) return

    pendingFocus.current = undefined
    element.focus()
  })

  function setError(name: ManualFieldName, message: string | undefined): void {
    setErrors((current) => ({ ...current, [name]: message }))
  }

  function openAll(names: readonly ManualFieldName[]): void {
    for (const name of names) {
      if (!snapshots.current.has(name)) {
        snapshots.current.set(name, { ...values, authors: [...values.authors] })
      }
    }

    setOpenNames((current) => new Set([...current, ...names]))
  }

  function close(name: ManualFieldName): void {
    snapshots.current.delete(name)
    pendingFocus.current = { name, target: 'trigger' }
    setOpenNames((current) => new Set([...current].filter((openName) => openName !== name)))
  }

  return {
    values,
    errors,
    change: (key, value) => {
      setValues((current) => withField(current, key, value))
      setErrors((current) => ({ ...current, [key]: undefined, form: undefined }))
    },
    isOpen: (name) => openNames.has(name),
    open: (name) => {
      openAll([name])
      pendingFocus.current = { name, target: 'control' }
    },
    confirm: (name) => {
      const message = manualFieldError(values, name, presetWorkId)

      setError(name, message)

      if (message === undefined) close(name)
      else pendingFocus.current = { name, target: 'control' }
    },
    cancel: (name) => {
      const snapshot = snapshots.current.get(name)

      if (snapshot !== undefined) setValues((current) => withField(current, name, snapshot[name]))

      setError(name, undefined)
      close(name)
    },
    registerTrigger: (name, element) => {
      if (element === null) triggers.current.delete(name)
      else triggers.current.set(name, element)
    },
    registerEditor: (name, element) => {
      if (element === null) editors.current.delete(name)
      else editors.current.set(name, element)
    },
    isSectionOpen: (section) => sections[section],
    setSectionOpen: (section, open) => {
      setSections((current) =>
        current[section] === open ? current : { ...current, [section]: open },
      )
    },
    submit: () => {
      const built = buildManualTarget(values, presetWorkId)

      if (built.ok) {
        snapshots.current.clear()
        setOpenNames(new Set())
        setErrors({})

        return built.target
      }

      const reveal = manualRevealOf(built.errors)
      const [first] = reveal.fields

      setErrors(built.errors)
      openAll(reveal.fields)
      setSections((current) => ({
        ...current,
        ...Object.fromEntries(reveal.sections.map((section) => [section, true])),
      }))

      if (first !== undefined) pendingFocus.current = { name: first, target: 'control' }

      return undefined
    },
  }
}
