import {
  libraryImportDraftResponseSchema,
  type LibraryImportDraftResponse,
  type LibraryImportFormat,
  type LibraryImportRowPatchRequest,
} from '@bookswap/shared'
import { apiRequest } from '@/app/lib/api'

/**
 * Stage 8f-3 and 8g: the four endpoints of one import.
 *
 * Every call parses the answer with the shared schema, so the row table and the
 * readiness banner can only ever render a shape the API actually promised.
 */

/**
 * The format travels explicitly even though the API defaults to CSV when it is
 * missing: a request that says what it is sending cannot be misread if that
 * default ever changes, and the server still decides what the bytes really are.
 */
export function previewLibraryImport(
  format: LibraryImportFormat,
  contentBase64: string,
): Promise<LibraryImportDraftResponse> {
  return apiRequest('/me/library/imports/preview', {
    method: 'POST',
    body: { format, contentBase64 },
    schema: libraryImportDraftResponseSchema,
  })
}

export function fetchLibraryImportDraft(
  importId: string,
  signal?: AbortSignal,
): Promise<LibraryImportDraftResponse> {
  return apiRequest(`/me/library/imports/${encodeURIComponent(importId)}`, {
    schema: libraryImportDraftResponseSchema,
    ...(signal === undefined ? {} : { signal }),
  })
}

export interface PatchLibraryImportRowInput {
  importId: string
  rowNumber: number
  request: LibraryImportRowPatchRequest
}

/**
 * One row changes; the whole recomputed draft comes back (R12). The response is
 * the new truth for counts, readiness AND the other rows — editing row 2 can
 * change row 7's `DUPLICATE_ROW` — so callers replace the cached document with
 * it rather than patching one row in place.
 */
export function patchLibraryImportRow({
  importId,
  rowNumber,
  request,
}: PatchLibraryImportRowInput): Promise<LibraryImportDraftResponse> {
  return apiRequest(
    `/me/library/imports/${encodeURIComponent(importId)}/rows/${String(rowNumber)}`,
    { method: 'PATCH', body: request, schema: libraryImportDraftResponseSchema },
  )
}

/**
 * Stage 8g: turn the draft into books.
 *
 * `expectedDraftVersion` is the version of the draft that is on screen (R6c) —
 * the server refuses the commit if anything has changed since, rather than
 * importing a draft the person never reviewed.
 *
 * The answer is the same document shape as every other call here: the import,
 * now `COMMITTED`, with no rows. Callers write it into the cache in place of
 * the draft, so the private notes of a finished import stop being held in a
 * browser that no longer has any use for them.
 */
export function commitLibraryImport(
  importId: string,
  expectedDraftVersion: string,
): Promise<LibraryImportDraftResponse> {
  return apiRequest(`/me/library/imports/${encodeURIComponent(importId)}/commit`, {
    method: 'POST',
    body: { expectedDraftVersion },
    schema: libraryImportDraftResponseSchema,
  })
}
