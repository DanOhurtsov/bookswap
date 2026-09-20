import { HttpStatus } from '@nestjs/common'
import { API_ERROR_CODES, type LibraryImportNotReadyDetails } from '@bookswap/shared'
import { ApiException } from '../../common/api.exception'

/**
 * Stage 8g (R6c): one refusal for every way a draft is not importable.
 *
 * The message is a single sentence on purpose. Which rows and why is in
 * `details` — structured, localizable by the web, and free of row content: the
 * payload holds a private `note`, and an error body is no place for it.
 */
export function libraryImportNotReady(details: LibraryImportNotReadyDetails): ApiException {
  return new ApiException(
    API_ERROR_CODES.IMPORT_NOT_READY,
    'Чернетку імпорту не можна імпортувати в цьому стані',
    HttpStatus.CONFLICT,
    details,
  )
}

/**
 * A draft row failed `libraryImportRowRecordSchema` on write or read.
 *
 * On write it means a caller bug — nothing is persisted, the transaction never
 * starts. On read it means the stored JSON no longer matches the shared
 * contract. Either way it is an internal fault, not a user error: the message
 * names only where it happened, never payload content (it holds the private
 * `note`).
 */
export class LibraryImportPayloadError extends Error {
  constructor(
    readonly direction: 'write' | 'read',
    readonly rowNumber: number | undefined,
  ) {
    super(
      `Library import row payload failed validation on ${direction}` +
        (rowNumber === undefined ? '' : ` (row ${String(rowNumber)})`),
    )
    this.name = 'LibraryImportPayloadError'
  }
}
