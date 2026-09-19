import type { LibraryImportFormat } from '@bookswap/shared'
import { parseLibraryImportCsv, type LibraryImportCsvError } from './library-import-csv.parser'
import type { LibraryImportParsedRow } from './library-import-rows'
import { readLibraryImportXlsx } from './library-import-xlsx.reader'
import type { LibraryImportXlsxError } from './library-import-xlsx.errors'

/**
 * Stage 8f-4: the one place that knows there is more than one file format.
 *
 * Both readers answer with the same three things — the rows, the copy count and
 * the `sourceHash` — and everything downstream (resolution, drafts, row
 * actions, readiness, commit) is written against that and never learns which
 * format produced it. That is what keeps `.xlsx` support from becoming a second
 * import pipeline that drifts from the first.
 *
 * The hashes deliberately differ in rule, not just in value: CSV keeps 8f-1's
 * bytes-as-received hash untouched, so drafts saved before this stage are still
 * found; XLSX prefixes a format tag, so a workbook and a CSV listing the same
 * books stay two different imports.
 */

export type LibraryImportFileError = LibraryImportCsvError | LibraryImportXlsxError

export type LibraryImportFileResult =
  | { ok: true; sourceHash: string; rows: LibraryImportParsedRow[]; copyCount: number }
  | { ok: false; error: LibraryImportFileError }

export async function readLibraryImportFile(
  format: LibraryImportFormat,
  input: Uint8Array,
): Promise<LibraryImportFileResult> {
  if (format === 'XLSX') return readLibraryImportXlsx(input)

  const parsed = parseLibraryImportCsv(input)

  return parsed.ok
    ? { ok: true, sourceHash: parsed.sourceHash, rows: parsed.rows, copyCount: parsed.copyCount }
    : parsed
}
