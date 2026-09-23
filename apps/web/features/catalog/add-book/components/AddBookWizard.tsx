'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { workDetailResponseSchema } from '@bookswap/shared'
import { ApiRequestError, apiRequest, describeError } from '@/app/lib/api'
import { useSession } from '@/app/lib/use-session'
import { FormStatus } from '@/components/Form/FormStatus'
import {
  completeAddBook,
  continueAfterEdition,
  continueAfterTranslation,
  continueAfterWork,
  createSearchStep,
  repeatSameEdition,
  selectExistingEdition,
  selectExistingWork,
  startNewWork,
  type AddBookStep,
} from '../model/add-book-step'
import { readAddBookEntryMode } from '../model/add-book-entry-mode'
import { DEFAULT_COPY_DEFAULTS, type CopyDefaults } from '../model/copy-defaults'
import { AddBookShell } from './AddBookShell'
import { AddBookSuccess } from './AddBookSuccess'
import { CopyStep } from './CopyStep'
import { EditionStep } from './EditionStep'
import { SearchStep } from './SearchStep'
import { TranslationStep } from './TranslationStep'
import { WorkStep } from './WorkStep'

/**
 * §6.3, кроки 1–5: спершу пошук дублікатів, потім один із трьох шляхів:
 * existing Edition → Copy; existing Work → Translation/Edition → Copy;
 * new Work → Translation/Edition → Copy. Lookup-дані лишаються редагованою
 * чернеткою, а автор ніколи не підбирається автоматично лише за ім'ям.
 */
export function AddBookWizard() {
  const router = useRouter()
  const parameters = useSearchParams()
  const { state: session } = useSession()
  const presetWorkId = parameters.get('workId')
  const initialQuery = parameters.get('q') ?? ''
  const entryMode = readAddBookEntryMode(parameters.get('mode'))

  const [step, setStep] = useState<AddBookStep>(createSearchStep)
  const [copyDefaults, setCopyDefaults] = useState<CopyDefaults>(DEFAULT_COPY_DEFAULTS)
  const [failure, setFailure] = useState<unknown>()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  // Прихід зі сторінки твору: метадані вже є, лишається доповнити їх виданням.
  useEffect(() => {
    if (presetWorkId === null) return

    const controller = new AbortController()

    async function load(): Promise<void> {
      try {
        const detail = await apiRequest(`/works/${encodeURIComponent(presetWorkId ?? '')}`, {
          schema: workDetailResponseSchema,
          signal: controller.signal,
        })

        setStep(
          selectExistingWork({
            workId: detail.work.id,
            title: detail.work.title,
            entryMethod: 'MANUAL',
          }),
        )
      } catch (error) {
        if (controller.signal.aborted) return

        setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
      }
    }

    void load()

    return () => {
      controller.abort()
    }
  }, [presetWorkId])

  if (session.status === 'loading') {
    return (
      <AddBookShell step={step}>
        <p className="status status--pending">Перевіряю сесію…</p>
      </AddBookShell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <AddBookShell step={step}>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </AddBookShell>
    )
  }

  return (
    <AddBookShell step={step}>
      <FormStatus error={failure} />

      {step.kind === 'search' && (
        <SearchStep
          key={`${entryMode}:${initialQuery}`}
          initialQuery={initialQuery}
          onFoundEdition={(selection) => {
            setStep(selectExistingEdition(selection))
          }}
          onFoundWork={(selection) => {
            setStep(selectExistingWork(selection))
          }}
          onCreateNew={(selection) => {
            setStep(startNewWork(selection))
          }}
        />
      )}

      {step.kind === 'work' && (
        <WorkStep
          initialTitle={step.initialTitle}
          lookup={step.lookup}
          onCreated={(workId, title) => {
            setStep(continueAfterWork(step, { workId, title }))
          }}
        />
      )}

      {step.kind === 'translation' && (
        <TranslationStep
          workId={step.workId}
          lookup={step.lookup}
          existingTranslations={step.existingTranslations}
          onDone={(translationId) => {
            setStep(continueAfterTranslation(step, translationId))
          }}
        />
      )}

      {step.kind === 'edition' && (
        <EditionStep
          workId={step.workId}
          translationId={step.translationId}
          lookup={step.lookup}
          initialIsbn={step.isbn}
          onCreated={(editionId) => {
            setStep(continueAfterEdition(step, editionId))
          }}
        />
      )}

      {step.kind === 'copy' && (
        <CopyStep
          editionId={step.editionId}
          defaults={copyDefaults}
          entryMethod={step.entryMethod}
          onDone={(nextDefaults) => {
            setCopyDefaults(nextDefaults)
            setStep(completeAddBook(step))
          }}
        />
      )}

      {step.kind === 'done' && (
        <AddBookSuccess
          title={step.title}
          workId={step.workId}
          onRepeatEdition={() => {
            setStep(repeatSameEdition(step))
          }}
          onAddNext={() => {
            setFailure(undefined)
            setStep(createSearchStep())
            router.push('/catalog/new')
          }}
          onScanNext={() => {
            setFailure(undefined)
            setStep(createSearchStep())
            router.push('/catalog/new?mode=scan')
          }}
        />
      )}
    </AddBookShell>
  )
}
