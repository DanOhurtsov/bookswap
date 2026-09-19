import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'

/**
 * Stage 8f-3: turn the chosen file into exactly the bytes 8f-2 expects.
 *
 * The one rule that matters here is that the browser must not *interpret* the
 * file. `File.text()` decodes to a JS string and re-encodes on the way out,
 * which silently strips a UTF-8 BOM, can rewrite line endings and normalizes
 * nothing predictably — and R6a defines the 48 KiB cap, `INVALID_ENCODING` and
 * `sourceHash` on the bytes *as received*. So the file is read as an
 * `ArrayBuffer` and base64-encoded byte by byte: the same file uploaded twice
 * hashes the same, and a file that is not valid UTF-8 reaches the server still
 * broken, to be told so honestly instead of being repaired on the way.
 *
 * No CSV parsing happens in the browser at all. The server is the parser and
 * the only validator; the size check below is a courtesy that saves an upload,
 * not a second opinion.
 */

export type CsvFileReadFailure = { reason: 'TOO_LARGE' | 'EMPTY'; size: number }

export type CsvFileReadResult =
  { ok: true; contentBase64: string } | ({ ok: false } & CsvFileReadFailure)

/**
 * `btoa` takes a "binary string" — one character per byte — so the bytes are
 * mapped through `String.fromCharCode` in chunks. Chunked because spreading a
 * 48 KiB array into one call is fine but an unbounded one is not, and the
 * transport cap (`maxRequestBytes`) is what actually bounds this input.
 */
const BINARY_CHUNK_SIZE = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE))
  }

  return btoa(binary)
}

export async function readCsvFileAsBase64(file: File): Promise<CsvFileReadResult> {
  // Checked before reading: there is no reason to pull 10 MB into memory to
  // discover it is 10 MB. The server re-checks and owns the verdict.
  if (file.size > LIBRARY_IMPORT_LIMITS.maxBytes) {
    return { ok: false, reason: 'TOO_LARGE', size: file.size }
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  if (bytes.length === 0) return { ok: false, reason: 'EMPTY', size: 0 }

  return { ok: true, contentBase64: bytesToBase64(bytes) }
}
