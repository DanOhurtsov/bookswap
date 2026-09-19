/** @jest-environment jsdom */

import { TextDecoder, TextEncoder } from 'node:util'
import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import { bytesToBase64, readCsvFileAsBase64 } from './csv-file'

/**
 * The rules under test are byte rules, not text rules: R6a defines the size
 * cap, `INVALID_ENCODING` and `sourceHash` on the file exactly as received. A
 * browser that decodes and re-encodes on the way out would change all three
 * without anyone noticing, so these assert the bytes survive untouched.
 */

/** jsdom's `File` has no `arrayBuffer()` in this environment; the bytes are the point. */
function fileOf(bytes: Uint8Array): File {
  return {
    size: bytes.byteLength,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as File
}

function decode(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

it('keeps a leading UTF-8 BOM in the encoded bytes', async () => {
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x73, 0x62, 0x6e])

  const result = await readCsvFileAsBase64(fileOf(bytes))

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(Array.from(decode(result.contentBase64))).toEqual(Array.from(bytes))
})

it('keeps CRLF line endings exactly as the file spelled them', async () => {
  const bytes = new TextEncoder().encode('isbn13\r\n9780306406157\r\n')

  const result = await readCsvFileAsBase64(fileOf(bytes))

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(new TextDecoder().decode(decode(result.contentBase64))).toBe('isbn13\r\n9780306406157\r\n')
})

it('passes bytes that are not valid UTF-8 through unrepaired', async () => {
  // A lone continuation byte: the server must be the one to answer
  // `INVALID_ENCODING`, and it can only do that if the browser did not "fix" it.
  const bytes = new Uint8Array([0x69, 0x73, 0xff, 0x62, 0x6e])

  const result = await readCsvFileAsBase64(fileOf(bytes))

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(Array.from(decode(result.contentBase64))).toEqual([0x69, 0x73, 0xff, 0x62, 0x6e])
})

it('encodes multi-byte characters as their UTF-8 bytes, not code units', () => {
  const bytes = new TextEncoder().encode('Шантарам')

  expect(Array.from(decode(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
})

it('rejects a file over the shared size cap before reading it', async () => {
  const oversized = LIBRARY_IMPORT_LIMITS.maxBytes + 1
  const arrayBuffer = jest.fn()
  const file = { size: oversized, arrayBuffer } as unknown as File

  const result = await readCsvFileAsBase64(file)

  expect(result).toEqual({ ok: false, reason: 'TOO_LARGE', size: oversized })
  expect(arrayBuffer).not.toHaveBeenCalled()
})

it('accepts a file exactly at the cap', async () => {
  const bytes = new Uint8Array(LIBRARY_IMPORT_LIMITS.maxBytes).fill(0x61)

  const result = await readCsvFileAsBase64(fileOf(bytes))

  expect(result.ok).toBe(true)
})

it('reports an empty file instead of sending zero bytes', async () => {
  const result = await readCsvFileAsBase64(fileOf(new Uint8Array(0)))

  expect(result).toEqual({ ok: false, reason: 'EMPTY', size: 0 })
})
