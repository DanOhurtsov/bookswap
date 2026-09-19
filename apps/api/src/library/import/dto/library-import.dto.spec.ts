import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import {
  LIBRARY_IMPORT_CONTENT_BASE64_MAX,
  libraryImportPreviewRequestSchema,
  libraryImportRowPatchRequestSchema,
} from '@bookswap/shared'
import {
  LibraryImportPreviewDto,
  LibraryImportRowParamsDto,
  LibraryImportRowPatchDto,
} from './library-import.dto'

/**
 * §11: both validators guard the same contract, so they must reach the same
 * verdict on the same body. The test compares verdicts, not sources — two
 * implementations that merely look alike would still be free to drift.
 */

/** The global pipe's settings, so a DTO here behaves exactly as it does in the app. */
function dtoAccepts<T extends object>(Dto: new () => T, body: unknown): boolean {
  const instance = plainToInstance(Dto, body, { enableImplicitConversion: false })
  const errors = validateSync(instance as object, {
    whitelist: true,
    forbidNonWhitelisted: true,
  })

  return errors.length === 0
}

describe('LibraryImportPreviewDto ↔ libraryImportPreviewRequestSchema', () => {
  it('reads a body with no format as CSV on both sides', () => {
    const parsed = libraryImportPreviewRequestSchema.parse({ contentBase64: 'aXNibjEz' })

    expect(parsed.format).toBe('CSV')

    const dto = plainToInstance(
      LibraryImportPreviewDto,
      { contentBase64: 'aXNibjEz' },
      { enableImplicitConversion: false },
    )

    // The DTO leaves it absent and the controller coalesces; what matters is
    // that neither side rejects the body the 8f-2 clients already send.
    expect(dto.format).toBeUndefined()
  })

  const bodies: unknown[] = [
    { contentBase64: 'aXNibjEz' },
    { contentBase64: 'aXNibjEzLA==' },
    { contentBase64: '' },
    { contentBase64: 'data:text/csv;base64,aXNibjEz' },
    { contentBase64: 'aXNi bjEz' },
    { contentBase64: 'aXNibjEz\n' },
    { contentBase64: 'aXNibjEz-_' },
    { contentBase64: 'aXNibjEz=' },
    { contentBase64: 'A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX) },
    { contentBase64: 'A'.repeat(LIBRARY_IMPORT_CONTENT_BASE64_MAX + 4) },
    { contentBase64: 42 },
    {},
    { contentBase64: 'aXNibjEz', extra: true },
    // 8f-4: the format discriminator. Absent is CSV; everything else has to be
    // one of the two names, because a client that said something we did not
    // understand must hear about it rather than get the other format.
    { format: 'CSV', contentBase64: 'aXNibjEz' },
    { format: 'XLSX', contentBase64: 'aXNibjEz' },
    { format: undefined, contentBase64: 'aXNibjEz' },
    { format: null, contentBase64: 'aXNibjEz' },
    { format: '', contentBase64: 'aXNibjEz' },
    { format: 'csv', contentBase64: 'aXNibjEz' },
    { format: 'XLS', contentBase64: 'aXNibjEz' },
    { format: 'xlsx', contentBase64: 'aXNibjEz' },
    { format: 42, contentBase64: 'aXNibjEz' },
    { format: ['CSV'], contentBase64: 'aXNibjEz' },
  ]

  it.each(bodies)('reaches the same verdict on %j', (body) => {
    expect(dtoAccepts(LibraryImportPreviewDto, body)).toBe(
      libraryImportPreviewRequestSchema.safeParse(body).success,
    )
  })
})

describe('LibraryImportRowPatchDto ↔ libraryImportRowPatchRequestSchema', () => {
  const bodies: unknown[] = [
    { action: 'EDIT', cells: { title: 'Дюна' } },
    { action: 'EDIT', cells: { isbn13: '9780306406157', quantity: '2' } },
    { action: 'EDIT', cells: {} },
    { action: 'EDIT', cells: { not_a_column: 'x' } },
    { action: 'EDIT', cells: { title: 42 } },
    { action: 'EDIT', cells: ['title'] },
    { action: 'EDIT' },
    { action: 'CHOOSE', workId: 'work-1' },
    { action: 'CHOOSE', workId: null },
    { action: 'CHOOSE', workId: '' },
    { action: 'CHOOSE' },
    { action: 'SKIP' },
    { action: 'RESTORE' },
    { action: 'RETRY' },
    { action: 'SKIP', workId: 'work-1' },
    { action: 'RETRY', cells: { title: 'Дюна' } },
    { action: 'EDIT', cells: { title: 'Дюна' }, workId: 'work-1' },
    { action: 'UNSKIP' },
    { action: 'edit', cells: { title: 'Дюна' } },
    {},
  ]

  it.each(bodies)('reaches the same verdict on %j', (body) => {
    expect(dtoAccepts(LibraryImportRowPatchDto, body)).toBe(
      libraryImportRowPatchRequestSchema.safeParse(body).success,
    )
  })
})

describe('LibraryImportRowParamsDto', () => {
  /**
   * Path segments arrive as strings and implicit conversion is off globally, so
   * without `@Type` every row number would fail `@IsInt` — including the valid
   * ones.
   */
  it('converts a path row number and rejects one no file could have', () => {
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: 'import-1', rowNumber: '7' })).toBe(true)
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: 'import-1', rowNumber: '0' })).toBe(false)
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: 'import-1', rowNumber: '201' })).toBe(false)
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: 'import-1', rowNumber: '1.5' })).toBe(false)
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: 'import-1', rowNumber: 'нуль' })).toBe(false)
    expect(dtoAccepts(LibraryImportRowParamsDto, { id: '', rowNumber: '1' })).toBe(false)
  })
})
