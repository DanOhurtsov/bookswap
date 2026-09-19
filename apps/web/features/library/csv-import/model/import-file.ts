import { LIBRARY_IMPORT_MAX_FILE_BYTES, type LibraryImportFormat } from '@bookswap/shared'

/**
 * Stage 8f-3, extended for `.xlsx` in 8f-4: turn the chosen file into exactly
 * the bytes the API expects, plus the one word that says what they are.
 *
 * The rule that mattered for CSV matters more for a workbook: the browser must
 * not *interpret* the file. `File.text()` decodes to a JS string and re-encodes
 * on the way out, which strips a UTF-8 BOM and can rewrite line endings — and
 * R6a defines the size cap, `INVALID_ENCODING` and `sourceHash` on the bytes as
 * received. A `.xlsx` is binary, so decoding it as text would not merely alter
 * it, it would destroy it. Both formats are therefore read as an `ArrayBuffer`
 * and base64-encoded byte by byte.
 *
 * Nothing about either format is parsed here. The server is the parser and the
 * only validator — the browser does not turn a workbook into a CSV, does not
 * read a sheet, and does not check a header. The extension below chooses which
 * reader the server uses, and the size check saves a pointless upload; neither
 * is a second opinion about the file.
 */

export type ImportFileReadFailure =
  | { reason: 'TOO_LARGE'; size: number; limit: number }
  | { reason: 'EMPTY'; size: 0 }
  | { reason: 'UNSUPPORTED_EXTENSION' }

export type ImportFileReadResult =
  | { ok: true; format: LibraryImportFormat; contentBase64: string }
  | ({ ok: false } & ImportFileReadFailure)

/** Extensions we offer. The server still decides what the bytes really are. */
const FORMAT_BY_EXTENSION: Readonly<Record<string, LibraryImportFormat>> = {
  csv: 'CSV',
  xlsx: 'XLSX',
}

/**
 * The `accept` attribute of the file input.
 *
 * `.xls` and `.xlsm` are deliberately absent: offering them in the picker and
 * then refusing the upload wastes the person's time twice over.
 */
export const IMPORT_FILE_ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function importFormatOf(fileName: string): LibraryImportFormat | undefined {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()

  return FORMAT_BY_EXTENSION[extension]
}

/**
 * `btoa` takes a "binary string" — one character per byte — so the bytes are
 * mapped through `String.fromCharCode` in chunks. Chunked because spreading a
 * large array into one call is what actually breaks, and a workbook is a great
 * deal larger than a CSV.
 */
const BINARY_CHUNK_SIZE = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE))
  }

  return btoa(binary)
}

export async function readImportFileAsBase64(file: File): Promise<ImportFileReadResult> {
  const format = importFormatOf(file.name)

  if (format === undefined) return { ok: false, reason: 'UNSUPPORTED_EXTENSION' }

  const limit = LIBRARY_IMPORT_MAX_FILE_BYTES[format]

  // Checked before reading: there is no reason to pull 10 MB into memory to
  // discover it is 10 MB. The server re-checks and owns the verdict.
  if (file.size > limit) return { ok: false, reason: 'TOO_LARGE', size: file.size, limit }

  const bytes = new Uint8Array(await file.arrayBuffer())

  if (bytes.length === 0) return { ok: false, reason: 'EMPTY', size: 0 }

  return { ok: true, format, contentBase64: bytesToBase64(bytes) }
}
