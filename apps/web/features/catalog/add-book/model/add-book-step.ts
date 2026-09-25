import type { BookLookupResult, CopyEntryMethod, Translation } from '@bookswap/shared'

type SearchStep = { kind: 'search' }

type WorkStep = {
  kind: 'work'
  initialTitle: string
  isbn?: string
  lookup?: BookLookupResult
  /**
   * The work's first publication year, when an external source supplied one.
   *
   * Separate from `lookup` on purpose: `BookLookupResult` describes an edition,
   * and every year in it means `Edition.year` (`app/lib/lookup-mapping.ts`).
   * `Work.firstPubYear` is a different field of a different entity, so only a
   * work-level year may prefill it — never the year of one printing.
   */
  firstPubYear?: number
  entryMethod: CopyEntryMethod
}

type CatalogContext = {
  workId: string
  title: string
  isbn?: string
  lookup?: BookLookupResult
  entryMethod: CopyEntryMethod
}

type TranslationStep = CatalogContext & {
  kind: 'translation'
  /** Only populated when the user selected an existing work. */
  existingTranslations?: Translation[]
}

type EditionStep = CatalogContext & {
  kind: 'edition'
  translationId: string | null
}

type CopyStep = {
  kind: 'copy'
  workId: string
  title: string
  editionId: string
  entryMethod: CopyEntryMethod
}

type DoneStep = { kind: 'done'; workId: string; title: string; editionId: string }

export type AddBookStep =
  SearchStep | WorkStep | TranslationStep | EditionStep | CopyStep | DoneStep

export type NewWorkInput = Omit<WorkStep, 'kind'>
export type ExistingWorkInput = Omit<TranslationStep, 'kind'>
export type ExistingEditionInput = Omit<CopyStep, 'kind'>
type CreatedWork = Pick<TranslationStep, 'workId' | 'title'>

export function createSearchStep(): SearchStep {
  return { kind: 'search' }
}

export function startNewWork(input: NewWorkInput): WorkStep {
  return { kind: 'work', ...input }
}

export function selectExistingWork(input: ExistingWorkInput): TranslationStep {
  return { kind: 'translation', ...input }
}

export function selectExistingEdition(input: ExistingEditionInput): CopyStep {
  return { kind: 'copy', ...input }
}

export function continueAfterWork(step: WorkStep, created: CreatedWork): TranslationStep {
  return {
    kind: 'translation',
    ...created,
    entryMethod: step.entryMethod,
    ...(step.isbn === undefined ? {} : { isbn: step.isbn }),
    ...(step.lookup === undefined ? {} : { lookup: step.lookup }),
  }
}

export function continueAfterTranslation(
  step: TranslationStep,
  translationId: string | null,
): EditionStep {
  return {
    kind: 'edition',
    workId: step.workId,
    title: step.title,
    translationId,
    entryMethod: step.entryMethod,
    ...(step.isbn === undefined ? {} : { isbn: step.isbn }),
    ...(step.lookup === undefined ? {} : { lookup: step.lookup }),
  }
}

export function continueAfterEdition(step: EditionStep, editionId: string): CopyStep {
  return {
    kind: 'copy',
    workId: step.workId,
    title: step.title,
    editionId,
    entryMethod: step.entryMethod,
  }
}

export function completeAddBook(step: CopyStep): DoneStep {
  return {
    kind: 'done',
    workId: step.workId,
    title: step.title,
    editionId: step.editionId,
  }
}

/** §R11: «Ще один такий примірник» не сканує заново — метод завжди MANUAL. */
export function repeatSameEdition(step: DoneStep): CopyStep {
  return {
    kind: 'copy',
    workId: step.workId,
    title: step.title,
    editionId: step.editionId,
    entryMethod: 'MANUAL',
  }
}
