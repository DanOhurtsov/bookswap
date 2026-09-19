import { LIBRARY_IMPORT_XLSX_LIMITS, libraryImportInvalidXlsxDetailsSchema } from '@bookswap/shared'
import { readLibraryImportXlsx } from './library-import-xlsx.reader'
import { xlsxWorkbook } from './library-import-xlsx.test-helpers'
import { buildZip, compressible } from './library-import-zip.test-helpers'
import { readXlsxContainer } from './library-import-zip'

/**
 * The container rules, exercised with archives that lie about themselves.
 *
 * Every case here is a file a person could upload, so every one of them must
 * end in a described refusal — never a throw, never an unbounded read, and
 * never a detail carrying the archive's own contents.
 */

async function reasonOf(file: Uint8Array): Promise<string> {
  const result = await readXlsxContainer(file)

  if (result.ok) throw new Error('expected a refusal')

  // Parsed, not just inspected: a detail shape that drifts from the contract
  // would render as `undefined` in the UI rather than fail here.
  if (result.error.code === 'IMPORT_INVALID_XLSX') {
    const { details } = result.error

    expect(libraryImportInvalidXlsxDetailsSchema.safeParse(details).success).toBe(true)

    return details.reason
  }

  return `TOO_LARGE:${result.error.details.limit}`
}

const WORKBOOK_XML = new TextEncoder().encode('<workbook/>')

function minimalParts(extra: readonly { name: string; data: Uint8Array }[] = []) {
  return [
    { name: '[Content_Types].xml', data: new TextEncoder().encode('<Types/>') },
    { name: 'xl/workbook.xml', data: WORKBOOK_XML },
    ...extra,
  ]
}

describe('container shape', () => {
  it('refuses a legacy .xls or a password-protected workbook with one honest reason', async () => {
    // Both are Compound File Binary documents and both open with this magic.
    // Telling them apart would be guesswork, so they share a refusal.
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])

    expect(await reasonOf(cfb)).toBe('UNSUPPORTED_CONTAINER')
  })

  it('refuses bytes that are not a ZIP at all', async () => {
    expect(await reasonOf(new TextEncoder().encode('isbn13,title\n'))).toBe('NOT_A_ZIP')
  })

  it('refuses a truncated archive instead of reading part of it', async () => {
    const file = await xlsxWorkbook()

    expect(await reasonOf(file.subarray(0, Math.floor(file.byteLength / 2)))).toBe('MALFORMED_ZIP')
  })

  it('accepts a workbook and hands on a rebuilt archive, not the original bytes', async () => {
    const file = await xlsxWorkbook()
    const result = await readXlsxContainer(file)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The whole point of the rebuild: ExcelJS never parses what arrived.
    expect(Buffer.from(result.canonical).equals(Buffer.from(file))).toBe(false)
    expect([...result.parts.keys()]).toContain('xl/workbook.xml')
    // Metadata that cannot carry a cell value is left out of the rebuild.
    expect([...result.parts.keys()].some((name) => name.startsWith('docProps/'))).toBe(false)
  })
})

describe('members that lie about their size', () => {
  it('refuses a stored member whose declared size is not its real one', async () => {
    const file = buildZip(
      minimalParts().map((part) =>
        part.name === 'xl/workbook.xml' ? { ...part, declaredUncompressedSize: 4 } : part,
      ),
    )

    expect(await reasonOf(file)).toBe('MALFORMED_ZIP')
  })

  it('stops a deflated member that produces more bytes than it declared', async () => {
    const file = buildZip([
      ...minimalParts(),
      {
        name: 'xl/sharedStrings.xml',
        data: compressible(512 * 1024),
        deflate: true,
        // Understated on purpose: the archive claims a kilobyte and delivers
        // half a megabyte. The read has to end when the claim runs out, not
        // when the stream does.
        declaredUncompressedSize: 1024,
      },
    ])

    expect(await reasonOf(file)).toBe('MALFORMED_ZIP')
  })

  it('refuses a member declaring more than the whole uncompressed budget', async () => {
    const oversized = LIBRARY_IMPORT_XLSX_LIMITS.maxUncompressedBytes + 1
    const file = buildZip([
      ...minimalParts(),
      {
        name: 'xl/sharedStrings.xml',
        data: WORKBOOK_XML,
        // Deflated so the claim survives the central directory: yauzl checks a
        // STORED member's sizes against each other immediately, which would
        // refuse this as malformed before the budget ever looked at it.
        deflate: true,
        declaredUncompressedSize: oversized,
      },
    ])

    expect(await reasonOf(file)).toBe('TOO_LARGE:UNCOMPRESSED_BYTES')
  })

  it('refuses a member that expands far beyond the allowed ratio', async () => {
    const file = buildZip([
      ...minimalParts(),
      { name: 'xl/sharedStrings.xml', data: compressible(1024 * 1024), deflate: true },
    ])

    expect(await reasonOf(file)).toBe('TOO_LARGE:COMPRESSION_RATIO')
  })

  it('refuses an archive with more members than allowed', async () => {
    const filler = Array.from(
      { length: LIBRARY_IMPORT_XLSX_LIMITS.maxEntries + 1 },
      (_unused, index) => ({ name: `docProps/part${String(index)}.xml`, data: WORKBOOK_XML }),
    )

    expect(await reasonOf(buildZip(filler))).toBe('TOO_LARGE:ZIP_ENTRIES')
  })
})

describe('members we refuse to carry', () => {
  it('refuses two members sharing one path rather than picking one', async () => {
    // JSZip keeps the last member of a duplicated path and a first-match
    // checker would have approved the other, which is precisely the
    // disagreement this refusal removes.
    const file = buildZip([
      ...minimalParts(),
      { name: 'xl/workbook.xml', data: new TextEncoder().encode('<workbook evil="1"/>') },
    ])

    expect(await reasonOf(file)).toBe('DUPLICATE_ENTRY')
  })

  it.each([
    ['../../etc/passwd', 'UNSAFE_ENTRY_PATH'],
    ['/absolute/workbook.xml', 'UNSAFE_ENTRY_PATH'],
    ['xl\\workbook.xml', 'UNSAFE_ENTRY_PATH'],
  ])('refuses the member path %s', async (name, expected) => {
    expect(await reasonOf(buildZip([{ name, data: WORKBOOK_XML }]))).toBe(expected)
  })

  it.each([
    ['xl/vbaProject.bin', 'MACRO_ENABLED'],
    ['xl/externalLinks/externalLink1.xml', 'EXTERNAL_LINKS'],
    ['xl/media/image1.png', 'FORBIDDEN_PART'],
    ['xl/activeX/activeX1.bin', 'FORBIDDEN_PART'],
  ])('refuses %s explicitly instead of dropping it', async (name, expected) => {
    expect(await reasonOf(buildZip([...minimalParts(), { name, data: WORKBOOK_XML }]))).toBe(
      expected,
    )
  })

  it('refuses an encrypted member', async () => {
    const file = buildZip([
      ...minimalParts(),
      { name: 'xl/sharedStrings.xml', data: WORKBOOK_XML, deflate: true, encrypted: true },
    ])

    expect(await reasonOf(file)).toBe('UNSUPPORTED_CONTAINER')
  })

  it('refuses an unsupported compression method', async () => {
    const file = buildZip([
      ...minimalParts(),
      { name: 'xl/sharedStrings.xml', data: WORKBOOK_XML, method: 99 },
    ])

    expect(await reasonOf(file)).toBe('MALFORMED_ZIP')
  })
})

describe('what the workbook declares about itself', () => {
  const RELS = 'xl/_rels/workbook.xml.rels'

  function rels(relationship: string): Uint8Array {
    return new TextEncoder().encode(`<Relationships>${relationship}</Relationships>`)
  }

  async function declaring(part: string, xml: Uint8Array): Promise<string> {
    return reasonOf(buildZip([...minimalParts(), { name: part, data: xml }]))
  }

  /**
   * Every row is the same declaration written a different legal way. XML says
   * they are identical; a substring search would say four of them are not,
   * which is precisely why this is parsed rather than scanned.
   */
  it.each([
    ['double quotes', '<Relationship Id="r1" TargetMode="External" Target="../other.xlsx"/>'],
    ['single quotes', "<Relationship Id='r1' TargetMode='External' Target='../other.xlsx'/>"],
    ['spaces around the equals sign', '<Relationship Id="r1" TargetMode = "External"/>'],
    ['a line break inside the tag', '<Relationship Id="r1"\n  TargetMode\n=\n"External"/>'],
    ['a plain external-link type', '<Relationship Id="r1" Type="http://x/externalLink"/>'],
    ['a decimal character reference', '<Relationship Id="r1" Type="http://x/extern&#97;lLink"/>'],
    ['a hex character reference', '<Relationship Id="r1" Type="http://x/extern&#x61;lLink"/>'],
    ['mixed case in the mode', '<Relationship Id="r1" TargetMode="EXTERNAL"/>'],
  ])('refuses an external workbook link written with %s', async (_name, relationship) => {
    expect(await declaring(RELS, rels(relationship))).toBe('EXTERNAL_LINKS')
  })

  it.each([
    [
      'a content type',
      '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>',
    ],
    [
      'single quotes',
      "<Types><Override ContentType='application/vnd.ms-excel.sheet.macroEnabled.main+xml'/></Types>",
    ],
    [
      'a character reference',
      '<Types><Override ContentType="application/vnd.ms-excel.sheet.macroEn&#97;bled.main+xml"/></Types>',
    ],
  ])('refuses a macro declaration written as %s', async (_name, xml) => {
    const file = buildZip([
      { name: '[Content_Types].xml', data: new TextEncoder().encode(xml) },
      { name: 'xl/workbook.xml', data: WORKBOOK_XML },
    ])

    expect(await reasonOf(file)).toBe('MACRO_ENABLED')
  })

  it('refuses a macro relationship type as well as a macro content type', async () => {
    const relationship = '<Relationship Id="r1" Type="http://x/vbaProject" Target="v.bin"/>'

    expect(await declaring(RELS, rels(relationship))).toBe('MACRO_ENABLED')
  })

  it('refuses a part carrying a DOCTYPE rather than reasoning about its entities', async () => {
    // No OOXML part needs one, and refusing it closes every entity-expansion
    // question instead of trusting a parser to decline politely.
    const xml = new TextEncoder().encode(
      '<!DOCTYPE Relationships [<!ENTITY a "External">]><Relationships><Relationship Id="r1" TargetMode="&a;"/></Relationships>',
    )

    expect(await declaring(RELS, xml)).toBe('MALFORMED_XLSX')
  })

  it('still accepts an ordinary relationship file', async () => {
    const relationship =
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    const file = buildZip([...minimalParts(), { name: RELS, data: rels(relationship) }])

    expect((await readXlsxContainer(file)).ok).toBe(true)
  })

  /**
   * The rule that matters to a person: both spellings have to be refused by
   * the reader they actually reach, not merely by the container check.
   */
  describe('through the whole reader, on a real workbook', () => {
    async function workbookWith(part: string, xml: string): Promise<Uint8Array> {
      const container = await readXlsxContainer(await xlsxWorkbook())

      if (!container.ok) throw new Error('expected a readable workbook')

      const parts = new Map(container.parts)

      parts.set(part, new TextEncoder().encode(xml))

      return buildZip([...parts].map(([name, data]) => ({ name, data })))
    }

    it.each([
      ['externalLink', 'http://x/externalLink'],
      ['extern&#97;lLink', 'http://x/extern&#97;lLink'],
    ])('refuses a workbook whose relationship type is %s', async (_name, type) => {
      const file = await workbookWith(
        RELS,
        `<Relationships><Relationship Id="r1" Type="${type}" Target="o.xlsx"/></Relationships>`,
      )
      const result = await readLibraryImportXlsx(file)

      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.details).toEqual({ reason: 'EXTERNAL_LINKS' })
    })
  })

  it('refuses an archive with no workbook part', async () => {
    const file = buildZip([{ name: '[Content_Types].xml', data: WORKBOOK_XML }])

    expect(await reasonOf(file)).toBe('MALFORMED_XLSX')
  })
})
