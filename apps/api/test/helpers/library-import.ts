import {
  API_PREFIX,
  LIBRARY_IMPORT_CSV_HEADER,
  libraryImportDraftResponseSchema,
  type LibraryImportCsvCells,
  type LibraryImportDraftResponse,
  type LibraryImportRowPatchRequest,
} from '@bookswap/shared'
import request from 'supertest'
import type { INestApplication } from '@nestjs/common'
import type { App } from 'supertest/types'

/** Test-only builders for the CSV import endpoints (Stage 8f-2). */

const QUOTE_TRIGGER = /[",;\r\n]/

function quote(value: string): string {
  return QUOTE_TRIGGER.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

export function csvRow(cells: Partial<LibraryImportCsvCells>): string {
  return LIBRARY_IMPORT_CSV_HEADER.map((column) => quote(cells[column] ?? '')).join(',')
}

export function csvContent(rows: readonly Partial<LibraryImportCsvCells>[]): string {
  return [LIBRARY_IMPORT_CSV_HEADER.join(','), ...rows.map(csvRow)].join('\n') + '\n'
}

/** The wire format agreed for 8f-2: raw bytes, base64-encoded, inside JSON. */
export function toBase64(content: string | Uint8Array): string {
  return Buffer.from(typeof content === 'string' ? content : content).toString('base64')
}

export function importUrl(path = ''): string {
  return `${API_PREFIX}/me/library/imports${path}`
}

export async function preview(
  app: INestApplication<App>,
  cookie: string,
  rows: readonly Partial<LibraryImportCsvCells>[],
): Promise<LibraryImportDraftResponse> {
  const response = await request(app.getHttpServer())
    .post(importUrl('/preview'))
    .set('Cookie', cookie)
    .send({ contentBase64: toBase64(csvContent(rows)) })
    .expect(201)

  return libraryImportDraftResponseSchema.parse(response.body)
}

export async function patchRow(
  app: INestApplication<App>,
  cookie: string,
  target: { importId: string; rowNumber: number },
  body: LibraryImportRowPatchRequest,
): Promise<LibraryImportDraftResponse> {
  const response = await request(app.getHttpServer())
    .patch(importUrl(`/${target.importId}/rows/${String(target.rowNumber)}`))
    .set('Cookie', cookie)
    .send(body)
    .expect(200)

  return libraryImportDraftResponseSchema.parse(response.body)
}

export function rowOf(
  draft: LibraryImportDraftResponse,
  rowNumber: number,
): LibraryImportDraftResponse['rows'][number] {
  const row = draft.rows.find((candidate) => candidate.rowNumber === rowNumber)

  if (row === undefined) throw new Error(`У чернетці немає рядка ${String(rowNumber)}`)

  return row
}

export function errorCodesOf(draft: LibraryImportDraftResponse, rowNumber: number): string[] {
  return rowOf(draft, rowNumber).errors.map((error) => error.code)
}

/**
 * The version a row had in THIS draft snapshot.
 *
 * Tests pass it explicitly rather than letting a helper fetch the current one:
 * the staleness cases below are exactly the ones that must hand over an old
 * snapshot's version on purpose.
 */
export function versionOf(draft: LibraryImportDraftResponse, rowNumber: number): string {
  return rowOf(draft, rowNumber).rowVersion
}
