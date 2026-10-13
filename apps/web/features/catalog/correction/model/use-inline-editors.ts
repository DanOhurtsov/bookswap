'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { FieldValues, Path, PathValue, UseFormReturn } from 'react-hook-form'
import { copyFormValue, plainDataEqual } from './form-values'

/** What one open editor restores on «Скасувати» — the value from the moment it opened. */
interface Snapshot {
  restore: () => void
  /** Structural and key-order independent — `plainDataEqual`. */
  equals: (value: unknown) => boolean
}

interface FocusRequest {
  name: string
  target: 'control' | 'trigger'
}

/** The part a single field's view/editor needs — see `InlineField`. */
export interface InlineEditors<TName extends string> {
  isOpen: (name: TName) => boolean
  /** Opens the editor and focuses its first control. Never touches the value or dirty state. */
  open: (name: TName) => void
  /** Validates this field with the form's own resolver and closes only when valid. Never submits. */
  confirm: (name: TName) => Promise<void>
  /** Restores the value from when THIS editor opened; every other field keeps its draft. */
  cancel: (name: TName) => void
  registerTrigger: (name: TName, element: HTMLElement | null) => void
  registerEditor: (name: TName, element: HTMLElement | null) => void
}

export interface FormInlineEditors<TValues extends FieldValues> extends InlineEditors<
  Path<TValues>
> {
  /** The general submit passed validation: what the open editors hold is part of the draft now. */
  closeAll: () => void
  /** The general submit failed validation: no invalid field may stay hidden behind its text. */
  reveal: (names: readonly Path<TValues>[]) => void
  /**
   * Moves an open editor's snapshot from `from` to an equivalent `to` — e.g.
   * server-assigned author ids replacing the names they were just created
   * from — so «Скасувати» cannot bring back a value the server already
   * consumed. A snapshot that differs from `from` is left alone.
   */
  rebaseSnapshot: <TName extends Path<TValues>>(
    name: TName,
    from: PathValue<TValues, TName>,
    to: PathValue<TValues, TName>,
  ) => void
}

type FormAccess<TValues extends FieldValues> = Pick<
  UseFormReturn<TValues>,
  'getValues' | 'setValue' | 'trigger' | 'clearErrors'
>

function firstControl(container: HTMLElement | undefined): HTMLElement | undefined {
  return (
    container?.querySelector<HTMLElement>('input, select, textarea') ??
    container?.querySelector<HTMLElement>('button') ??
    undefined
  )
}

/**
 * Inline editing over ONE react-hook-form draft (BS-76): each field shows as
 * text until its editor opens; the editor binds straight to the form field, so
 * the general «Зберегти» always sees what an open editor holds, and the draft
 * never lives anywhere but the form (§3.9 — not in the query cache).
 *
 * Owned by the form, not by each field: which editors are open must survive a
 * field switching between its two modes, and a failed general submit opens
 * several of them at once.
 */
export function useInlineEditors<TValues extends FieldValues>(
  form: FormAccess<TValues>,
): FormInlineEditors<TValues> {
  const [openNames, setOpenNames] = useState<ReadonlySet<string>>(() => new Set())
  const snapshots = useRef(new Map<string, Snapshot>())
  const triggers = useRef(new Map<string, HTMLElement>())
  const editors = useRef(new Map<string, HTMLElement>())
  // A ref, consumed by the dep-less effect below: the element to focus only
  // exists after the render that mounts it has committed. A layout effect, so
  // focus moves in the same commit even when the update came from an awaited
  // validation rather than a click handler.
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

  function snapshotOf<TName extends Path<TValues>>(
    name: TName,
    value: PathValue<TValues, TName>,
  ): Snapshot {
    // An independent copy, not a reference: RHF writes nested paths in place —
    // `useController` on `authors.0` replaces that element inside the SAME
    // array object `getValues('authors')` returned — so a kept reference would
    // already hold the edit by the time «Скасувати» restores it.
    const copy = copyFormValue(value)

    return {
      restore: () => {
        // `shouldDirty` recomputes dirtiness against the defaults, so a field
        // restored to its original value is pristine again (Edition sends
        // `textKind`/`lang` only when dirty). `setValue` clones what it is
        // given, so `copy` stays intact for a later `equals`.
        form.setValue(name, copy, { shouldDirty: true })
      },
      equals: (other) => plainDataEqual(other, copy),
    }
  }

  function openAll(names: readonly Path<TValues>[]): void {
    for (const name of names) {
      if (!snapshots.current.has(name)) {
        snapshots.current.set(name, snapshotOf(name, form.getValues(name)))
      }
    }

    setOpenNames((current) => new Set([...current, ...names]))
  }

  function close(name: Path<TValues>): void {
    snapshots.current.delete(name)
    pendingFocus.current = { name, target: 'trigger' }
    setOpenNames((current) => new Set([...current].filter((openName) => openName !== name)))
  }

  return {
    isOpen: (name) => openNames.has(name),
    open: (name) => {
      openAll([name])
      pendingFocus.current = { name, target: 'control' }
    },
    confirm: async (name) => {
      if (await form.trigger(name, { shouldFocus: true })) close(name)
    },
    cancel: (name) => {
      snapshots.current.get(name)?.restore()
      form.clearErrors(name)
      close(name)
    },
    closeAll: () => {
      snapshots.current.clear()
      setOpenNames(new Set())
    },
    reveal: (names) => {
      const [first] = names

      if (first === undefined) return

      openAll(names)
      pendingFocus.current = { name: first, target: 'control' }
    },
    rebaseSnapshot: (name, from, to) => {
      if (snapshots.current.get(name)?.equals(from) === true) {
        snapshots.current.set(name, snapshotOf(name, to))
      }
    },
    registerTrigger: (name, element) => {
      if (element === null) triggers.current.delete(name)
      else triggers.current.set(name, element)
    },
    registerEditor: (name, element) => {
      if (element === null) editors.current.delete(name)
      else editors.current.set(name, element)
    },
  }
}
