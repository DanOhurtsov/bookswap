/** @jest-environment jsdom */

import { TextDecoder, TextEncoder } from 'node:util'
import { LIBRARY_IMPORT_LIMITS, LIBRARY_IMPORT_XLSX_LIMITS } from '@bookswap/shared'
import { bytesToBase64, importFormatOf, readImportFileAsBase64 } from './import-file'

/**
 * The rules under test are byte rules, not text rules: R6a defines the size
 * cap, `INVALID_ENCODING` and `sourceHash` on the file exactly as received. A
 * browser that decodes and re-encodes on the way out would change all three
 * without anyone noticing — and for a `.xlsx`, which is a binary archive, it
 * would not leave a readable file at all. These assert the bytes survive.
 */

/** jsdom's `File` has no `arrayBuffer()` in this environment; the bytes are the point. */
function fileOf(bytes: Uint8Array, name = 'books.csv'): File {
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: () =>
      Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
  } as unknown as File
}

function decode(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

describe('choosing the reader', () => {
  it.each([
    ['books.csv', 'CSV'],
    ['books.CSV', 'CSV'],
    ['Моя бібліотека.xlsx', 'XLSX'],
    ['books.XLSX', 'XLSX'],
  ])('reads %s as %s', (name, expected) => {
    expect(importFormatOf(name)).toBe(expected)
  })

  it.each(['books.xls', 'books.xlsm', 'books.ods', 'books.txt', 'books'])(
    'offers no format for %s',
    (name) => {
      expect(importFormatOf(name)).toBeUndefined()
    },
  )

  it('refuses an unsupported extension before reading the file', async () => {
    const arrayBuffer = jest.fn()
    const file = { name: 'books.xls', size: 10, arrayBuffer } as unknown as File

    expect(await readImportFileAsBase64(file)).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_EXTENSION',
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('tells the API which format it is sending', async () => {
    const result = await readImportFileAsBase64(fileOf(new Uint8Array([0x50, 0x4b]), 'b.xlsx'))

    expect(result).toMatchObject({ ok: true, format: 'XLSX' })
  })
})

describe('the bytes themselves', () => {
  it('keeps a leading UTF-8 BOM in the encoded bytes', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x69, 0x73, 0x62, 0x6e])

    const result = await readImportFileAsBase64(fileOf(bytes))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.from(decode(result.contentBase64))).toEqual(Array.from(bytes))
  })

  it('keeps CRLF line endings exactly as the file spelled them', async () => {
    const bytes = new TextEncoder().encode('isbn13\r\n9780306406157\r\n')

    const result = await readImportFileAsBase64(fileOf(bytes))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(new TextDecoder().decode(decode(result.contentBase64))).toBe(
      'isbn13\r\n9780306406157\r\n',
    )
  })

  it('passes bytes that are not valid UTF-8 through unrepaired', async () => {
    // A lone continuation byte: the server must be the one to answer
    // `INVALID_ENCODING`, and it can only do that if the browser did not "fix" it.
    const bytes = new Uint8Array([0x69, 0x73, 0xff, 0x62, 0x6e])

    const result = await readImportFileAsBase64(fileOf(bytes))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.from(decode(result.contentBase64))).toEqual([0x69, 0x73, 0xff, 0x62, 0x6e])
  })

  it('carries arbitrary binary bytes of a workbook through untouched', async () => {
    // Every byte value, including the ones no text encoding survives. A
    // workbook is a ZIP, so anything less than byte-exact is a broken file.
    const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index)

    const result = await readImportFileAsBase64(fileOf(bytes, 'books.xlsx'))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Array.from(decode(result.contentBase64))).toEqual(Array.from(bytes))
  })

  it('encodes multi-byte characters as their UTF-8 bytes, not code units', () => {
    const bytes = new TextEncoder().encode('Шантарам')

    expect(Array.from(decode(bytesToBase64(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('size, per format', () => {
  it('rejects a CSV over the CSV cap before reading it', async () => {
    const oversized = LIBRARY_IMPORT_LIMITS.maxBytes + 1
    const arrayBuffer = jest.fn()
    const file = { name: 'b.csv', size: oversized, arrayBuffer } as unknown as File

    expect(await readImportFileAsBase64(file)).toEqual({
      ok: false,
      reason: 'TOO_LARGE',
      size: oversized,
      limit: LIBRARY_IMPORT_LIMITS.maxBytes,
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  it('accepts a workbook far larger than the CSV cap', async () => {
    // The whole point of a separate limit: this file is refused as a CSV and
    // perfectly ordinary as a workbook.
    const size = LIBRARY_IMPORT_LIMITS.maxBytes + 1

    expect(await readImportFileAsBase64(fileOf(new Uint8Array(size), 'b.xlsx'))).toMatchObject({
      ok: true,
      format: 'XLSX',
    })
  })

  it('rejects a workbook over the workbook cap', async () => {
    const oversized = LIBRARY_IMPORT_XLSX_LIMITS.maxBytes + 1
    const file = { name: 'b.xlsx', size: oversized, arrayBuffer: jest.fn() } as unknown as File

    expect(await readImportFileAsBase64(file)).toEqual({
      ok: false,
      reason: 'TOO_LARGE',
      size: oversized,
      limit: LIBRARY_IMPORT_XLSX_LIMITS.maxBytes,
    })
  })

  it('accepts a file exactly at the cap', async () => {
    const bytes = new Uint8Array(LIBRARY_IMPORT_LIMITS.maxBytes).fill(0x61)

    expect((await readImportFileAsBase64(fileOf(bytes))).ok).toBe(true)
  })

  it('reports an empty file instead of sending zero bytes', async () => {
    expect(await readImportFileAsBase64(fileOf(new Uint8Array(0)))).toEqual({
      ok: false,
      reason: 'EMPTY',
      size: 0,
    })
  })
})
