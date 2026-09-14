import {
  editionPatchResponseSchema,
  translationPatchResponseSchema,
  workPatchResponseSchema,
  type Edition,
  type EditionPatchRequest,
  type Translation,
  type TranslationPatchRequest,
  type Work,
  type WorkAuthor,
  type WorkPatchRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

export interface WorkCorrectionEntity {
  work: Work
  authors: WorkAuthor[]
}

export function patchWork(workId: string, body: WorkPatchRequest): Promise<WorkCorrectionEntity> {
  return apiRequest(`/works/${encodeURIComponent(workId)}`, {
    method: 'PATCH',
    body,
    schema: workPatchResponseSchema,
  })
}

export async function patchTranslation(
  translationId: string,
  body: TranslationPatchRequest,
): Promise<Translation> {
  const response = await apiRequest(`/translations/${encodeURIComponent(translationId)}`, {
    method: 'PATCH',
    body,
    schema: translationPatchResponseSchema,
  })

  return response.translation
}

export async function patchEdition(editionId: string, body: EditionPatchRequest): Promise<Edition> {
  const response = await apiRequest(`/editions/${encodeURIComponent(editionId)}`, {
    method: 'PATCH',
    body,
    schema: editionPatchResponseSchema,
  })

  return response.edition
}

/**
 * `409 CATALOG_REVISION_CONFLICT` carries the fresh entity in `ApiRequestError.details`
 * (R9), shaped exactly like the matching PATCH success response — these parse
 * it with the same schema rather than a third, hand-rolled shape.
 */
export function parseWorkConflict(details: unknown): WorkCorrectionEntity | undefined {
  const parsed = workPatchResponseSchema.safeParse(details)

  return parsed.success ? parsed.data : undefined
}

export function parseTranslationConflict(details: unknown): Translation | undefined {
  const parsed = translationPatchResponseSchema.safeParse(details)

  return parsed.success ? parsed.data.translation : undefined
}

export function parseEditionConflict(details: unknown): Edition | undefined {
  const parsed = editionPatchResponseSchema.safeParse(details)

  return parsed.success ? parsed.data.edition : undefined
}
