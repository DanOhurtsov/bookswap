import { zipSync } from 'fflate'
import { fromBuffer, type Entry, type ZipFile } from 'yauzl'
import { LIBRARY_IMPORT_XLSX_LIMITS } from '@bookswap/shared'
import { checkOoxmlDeclarations } from './library-import-ooxml'
import { invalidXlsx, tooLargeXlsx, type XlsxFailure } from './library-import-xlsx.errors'

/**
 * Stage 8f-4 (agreed PO decision, 2026-09-19): turn received bytes into a
 * workbook ExcelJS is allowed to read — or into a refusal.
 *
 * **Why this module exists at all.** `Workbook.xlsx.load()` hands the buffer to
 * JSZip and then decompresses every member in full. JSZip enforces no bound of
 * any kind, so an archive that expands to gigabytes is simply expanded. The
 * cap therefore has to be applied before ExcelJS ever sees the file.
 *
 * **Why the archive is rebuilt rather than merely inspected.** Checking one
 * buffer and then passing that same buffer on means two ZIP implementations
 * read the same bytes, and their agreement is an assumption. They genuinely
 * differ: JSZip keys members by name, so of two members sharing a path the last
 * one wins, while a checker that stops at the first would have approved the
 * other. So nothing here approves the original archive. It extracts the members
 * it recognises, under a byte budget, and builds a NEW archive from exactly
 * those bytes. ExcelJS parses an archive written by this file — one member per
 * path, sizes exact, no traversal, no ZIP64 — and the question of whether two
 * parsers agree never arises.
 *
 * Nothing is written to disk at any point, and no error detail carries a member
 * path, a sheet name or any other file content.
 */

export type LibraryImportZipResult =
  { ok: true; canonical: Uint8Array; parts: ReadonlyMap<string, Uint8Array> } | XlsxFailure

/** Compound File Binary: both a legacy `.xls` and a password-protected workbook. */
const CFB_MAGIC = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)

const ZIP_MAGIC = Uint8Array.of(0x50, 0x4b, 0x03, 0x04)

/**
 * The OOXML members a workbook's cell values can depend on. Everything outside
 * this list is refused rather than quietly dropped, so a file whose data lives
 * somewhere we do not look is never imported as if it did not.
 */
const KEPT_PARTS = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^xl\/workbook\.xml$/,
  /^xl\/_rels\/workbook\.xml\.rels$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/styles\.xml$/,
  /^xl\/theme\/theme\d+\.xml$/,
  /^xl\/worksheets\/sheet\d+\.xml$/,
  /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/,
]

/**
 * Members that provably say nothing about a cell's value, so leaving them out
 * of the rebuilt archive changes no data: document metadata, the cached
 * recalculation order (we refuse formulas outright) and printer setup.
 */
const DROPPED_PARTS = [
  /^docProps\//,
  /^xl\/calcChain\.xml$/,
  /^xl\/printerSettings\//,
  /^customXml\//,
]

const MACRO_PART = /^xl\/vbaProject\.bin$/
const EXTERNAL_LINK_PART = /^xl\/externalLinks\//

/** yauzl's own wording for the three unsafe-path cases it refuses to hand over. */
const UNSAFE_PATH_MESSAGES = [
  'invalid characters in fileName',
  'absolute path:',
  'invalid relative path:',
]

function startsWith(input: Uint8Array, magic: Uint8Array): boolean {
  return magic.every((byte, index) => input[index] === byte)
}

/** Thrown to abandon the whole read, not just the member that broke the budget. */
class BudgetExceededError extends Error {
  constructor(readonly spent: number) {
    super('Розпакований обсяг перевищив дозволений')
  }
}

/**
 * The real decompressed total, counted as bytes arrive.
 *
 * Deliberately not the archive's declared `uncompressedSize`, which is checked
 * separately and which costs an attacker nothing to understate: this is the
 * number that actually guarantees the read terminates.
 */
class ByteBudget {
  private spent = 0

  constructor(private readonly limit: number) {}

  /** `false` once the real total has passed the limit; the caller then stops. */
  take(count: number): boolean {
    this.spent += count

    return this.spent <= this.limit
  }

  get used(): number {
    return this.spent
  }
}

function openZip(input: Uint8Array): Promise<ZipFile> {
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength)

  return new Promise((resolve, reject) => {
    // `validateEntrySizes` makes yauzl itself refuse a member whose real size
    // is not the one the archive claims — in either direction.
    //
    // `strictFileNames` matters more than it looks: left off, yauzl rewrites a
    // backslash in a member name into a forward slash, so `xl\workbook.xml`
    // would become the workbook here while JSZip kept the literal name and
    // found no workbook at all. That is exactly the divergence between two
    // readers this module exists to rule out, so such a name is refused.
    fromBuffer(
      buffer,
      {
        lazyEntries: true,
        validateEntrySizes: true,
        decodeStrings: true,
        strictFileNames: true,
        autoClose: false,
      },
      (error, zipfile) => (error ? reject(error) : resolve(zipfile)),
    )
  })
}

/** Reads the central directory only; no member is decompressed here. */
function listEntries(zipfile: ZipFile): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: Entry[] = []

    zipfile.on('entry', (entry: Entry) => {
      entries.push(entry)
      zipfile.readEntry()
    })
    zipfile.on('end', () => resolve(entries))
    zipfile.on('error', reject)
    zipfile.readEntry()
  })
}

function readEntry(zipfile: ZipFile, entry: Entry, budget: ByteBudget): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error !== null) {
        reject(error)

        return
      }

      const chunks: Buffer[] = []

      stream.on('data', (chunk: Buffer) => {
        if (!budget.take(chunk.length)) {
          // Destroying the stream stops this member; the rejection abandons
          // the whole read, so no later member is decompressed either.
          stream.destroy()
          reject(new BudgetExceededError(budget.used))

          return
        }

        chunks.push(chunk)
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
    })
  })
}

export interface ZipEntryVerdict {
  keep: boolean
  error?: LibraryImportZipResult
}

/** One member's fate, decided from its path alone and before anything is read. */
function classify(name: string): ZipEntryVerdict {
  if (name.endsWith('/')) return { keep: false }
  if (MACRO_PART.test(name)) return { keep: false, error: invalidXlsx({ reason: 'MACRO_ENABLED' }) }
  if (EXTERNAL_LINK_PART.test(name)) {
    return { keep: false, error: invalidXlsx({ reason: 'EXTERNAL_LINKS' }) }
  }
  if (KEPT_PARTS.some((part) => part.test(name))) return { keep: true }
  if (DROPPED_PARTS.some((part) => part.test(name))) return { keep: false }

  return { keep: false, error: invalidXlsx({ reason: 'FORBIDDEN_PART' }) }
}

/** Metadata caps, all of them answerable from the central directory alone. */
function checkMetadata(entries: readonly Entry[]): LibraryImportZipResult | undefined {
  if (entries.length > LIBRARY_IMPORT_XLSX_LIMITS.maxEntries) {
    return tooLargeXlsx({
      limit: 'ZIP_ENTRIES',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxEntries,
      actual: entries.length,
    })
  }

  const seen = new Set<string>()
  let declared = 0

  for (const entry of entries) {
    if (seen.has(entry.fileName)) return invalidXlsx({ reason: 'DUPLICATE_ENTRY' })

    seen.add(entry.fileName)
    declared += entry.uncompressedSize

    const failure = checkEntrySize(entry)

    if (failure !== undefined) return failure
  }

  return declared > LIBRARY_IMPORT_XLSX_LIMITS.maxUncompressedBytes
    ? tooLargeXlsx({
        limit: 'UNCOMPRESSED_BYTES',
        max: LIBRARY_IMPORT_XLSX_LIMITS.maxUncompressedBytes,
        actual: declared,
      })
    : undefined
}

/** General-purpose bit 0: the member is encrypted, whatever else it claims. */
const ENCRYPTED_BIT = 0x1

function checkEntrySize(entry: Entry): LibraryImportZipResult | undefined {
  // Read from the central directory rather than waited for as a stream error:
  // a password-protected workbook should be named as one before anything is
  // decompressed, and it gets the same honest wording as a legacy .xls.
  if ((entry.generalPurposeBitFlag & ENCRYPTED_BIT) !== 0) {
    return invalidXlsx({ reason: 'UNSUPPORTED_CONTAINER' })
  }

  if (entry.uncompressedSize > LIBRARY_IMPORT_XLSX_LIMITS.maxEntryUncompressedBytes) {
    return tooLargeXlsx({
      limit: 'UNCOMPRESSED_BYTES',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxEntryUncompressedBytes,
      actual: entry.uncompressedSize,
    })
  }

  const ratio = Math.ceil(entry.uncompressedSize / Math.max(entry.compressedSize, 1))

  return ratio > LIBRARY_IMPORT_XLSX_LIMITS.maxCompressionRatio
    ? tooLargeXlsx({
        limit: 'COMPRESSION_RATIO',
        max: LIBRARY_IMPORT_XLSX_LIMITS.maxCompressionRatio,
        actual: ratio,
      })
    : undefined
}

function classifyReadError(error: unknown): LibraryImportZipResult {
  if (error instanceof BudgetExceededError) {
    return tooLargeXlsx({
      limit: 'UNCOMPRESSED_BYTES',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxUncompressedBytes,
      actual: error.spent,
    })
  }

  const message = error instanceof Error ? error.message : ''

  if (UNSAFE_PATH_MESSAGES.some((prefix) => message.startsWith(prefix))) {
    return invalidXlsx({ reason: 'UNSAFE_ENTRY_PATH' })
  }

  // Encrypted members, unsupported compression methods, a broken central
  // directory and a size that did not match the stream all land here.
  return message.includes('encrypted')
    ? invalidXlsx({ reason: 'UNSUPPORTED_CONTAINER' })
    : invalidXlsx({ reason: 'MALFORMED_ZIP' })
}

async function extract(
  zipfile: ZipFile,
  entries: readonly Entry[],
): Promise<LibraryImportZipResult> {
  const budget = new ByteBudget(LIBRARY_IMPORT_XLSX_LIMITS.maxUncompressedBytes)
  const parts = new Map<string, Uint8Array>()

  // Sequential on purpose: one member at a time keeps peak memory at one
  // member, and a refusal stops the whole read instead of racing the rest.
  for (const entry of entries) {
    const verdict = classify(entry.fileName)

    if (verdict.error !== undefined) return verdict.error
    if (!verdict.keep) continue

    parts.set(entry.fileName, await readEntry(zipfile, entry, budget))
  }

  const declared = checkOoxmlDeclarations(parts)

  if (declared !== undefined) return declared
  if (!parts.has('xl/workbook.xml')) return invalidXlsx({ reason: 'MALFORMED_XLSX' })

  return { ok: true, canonical: rebuild(parts), parts }
}

/** The archive ExcelJS will actually parse: stored, one member per path, ours. */
function rebuild(parts: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(parts), { level: 0 })
}

export async function readXlsxContainer(input: Uint8Array): Promise<LibraryImportZipResult> {
  if (startsWith(input, CFB_MAGIC)) return invalidXlsx({ reason: 'UNSUPPORTED_CONTAINER' })
  if (!startsWith(input, ZIP_MAGIC)) return invalidXlsx({ reason: 'NOT_A_ZIP' })

  let zipfile: ZipFile | undefined

  try {
    zipfile = await openZip(input)

    const entries = await listEntries(zipfile)
    const failure = checkMetadata(entries)

    return failure ?? (await extract(zipfile, entries))
  } catch (error) {
    return classifyReadError(error)
  } finally {
    zipfile?.close()
  }
}
