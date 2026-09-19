import {
  API_ERROR_CODES,
  type LibraryImportInvalidXlsxDetails,
  type LibraryImportTooLargeDetails,
} from '@bookswap/shared'

/**
 * Stage 8f-4: the refusal shape every step of the XLSX path answers with.
 *
 * Its own module because the container reader, the XML inspection and the
 * workbook reader all produce it, and each of them is imported by the next —
 * defining it in any one of them would close a cycle.
 */

export type LibraryImportXlsxError =
  | { code: typeof API_ERROR_CODES.IMPORT_TOO_LARGE; details: LibraryImportTooLargeDetails }
  | { code: typeof API_ERROR_CODES.IMPORT_INVALID_XLSX; details: LibraryImportInvalidXlsxDetails }

export type XlsxFailure = { ok: false; error: LibraryImportXlsxError }

export function invalidXlsx(details: LibraryImportInvalidXlsxDetails): XlsxFailure {
  return { ok: false, error: { code: API_ERROR_CODES.IMPORT_INVALID_XLSX, details } }
}

export function tooLargeXlsx(details: LibraryImportTooLargeDetails): XlsxFailure {
  return { ok: false, error: { code: API_ERROR_CODES.IMPORT_TOO_LARGE, details } }
}

export function isXlsxFailure<T extends object>(value: T | XlsxFailure): value is XlsxFailure {
  return 'ok' in value && value.ok === false
}
