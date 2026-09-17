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
