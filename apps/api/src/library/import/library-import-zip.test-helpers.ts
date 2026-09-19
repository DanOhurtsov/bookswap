import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Test-only ZIP writer; not used by production code.
 *
 * `fflate` and every other library writes *correct* archives, which is exactly
 * what these tests cannot use: the container rules exist for archives that lie
 * about themselves. So the headers are assembled by hand, with the declared
 * sizes, the member names and the number of members all under the test's
 * control — a forged `uncompressedSize` is a field here, not an accident.
 *
 * Deliberately minimal: STORED or DEFLATE, no ZIP64, no data descriptors.
 */

export interface ZipEntrySpec {
  name: string
  data: Uint8Array
  /** Written into both headers instead of the real size, to forge a mismatch. */
  declaredUncompressedSize?: number
  declaredCompressedSize?: number
  deflate?: boolean
  /** Sets the general-purpose encryption bit without actually encrypting. */
  encrypted?: boolean
  /** An unknown compression method, to exercise the unsupported-method path. */
  method?: number
}

const LOCAL_SIGNATURE = 0x04034b50
const CENTRAL_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

interface PreparedEntry {
  name: Buffer
  payload: Buffer
  crc: number
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  offset: number
}

function prepare(spec: ZipEntrySpec): Omit<PreparedEntry, 'offset'> {
  const raw = Buffer.from(spec.data)
  const payload = spec.deflate === true ? deflateRawSync(raw) : raw

  return {
    name: Buffer.from(spec.name, 'utf8'),
    payload,
    crc: crc32(raw),
    method: spec.method ?? (spec.deflate === true ? 8 : 0),
    flags: spec.encrypted === true ? 0x1 : 0,
    compressedSize: spec.declaredCompressedSize ?? payload.byteLength,
    uncompressedSize: spec.declaredUncompressedSize ?? raw.byteLength,
  }
}

function localHeader(entry: Omit<PreparedEntry, 'offset'>): Buffer {
  const header = Buffer.alloc(30)

  header.writeUInt32LE(LOCAL_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(entry.flags, 6)
  header.writeUInt16LE(entry.method, 8)
  header.writeUInt32LE(entry.crc, 14)
  header.writeUInt32LE(entry.compressedSize, 18)
  header.writeUInt32LE(entry.uncompressedSize, 22)
  header.writeUInt16LE(entry.name.byteLength, 26)

  return Buffer.concat([header, entry.name, entry.payload])
}

function centralHeader(entry: PreparedEntry): Buffer {
  const header = Buffer.alloc(46)

  header.writeUInt32LE(CENTRAL_SIGNATURE, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(entry.flags, 8)
  header.writeUInt16LE(entry.method, 10)
  header.writeUInt32LE(entry.crc, 16)
  header.writeUInt32LE(entry.compressedSize, 20)
  header.writeUInt32LE(entry.uncompressedSize, 24)
  header.writeUInt16LE(entry.name.byteLength, 28)
  header.writeUInt32LE(entry.offset, 42)

  return Buffer.concat([header, entry.name])
}

export function buildZip(specs: readonly ZipEntrySpec[]): Uint8Array {
  const locals: Buffer[] = []
  const prepared: PreparedEntry[] = []
  let offset = 0

  for (const spec of specs) {
    const entry = prepare(spec)
    const local = localHeader(entry)

    prepared.push({ ...entry, offset })
    locals.push(local)
    offset += local.byteLength
  }

  const central = Buffer.concat(prepared.map(centralHeader))
  const eocd = Buffer.alloc(22)

  eocd.writeUInt32LE(EOCD_SIGNATURE, 0)
  eocd.writeUInt16LE(prepared.length, 8)
  eocd.writeUInt16LE(prepared.length, 10)
  eocd.writeUInt32LE(central.byteLength, 12)
  eocd.writeUInt32LE(offset, 16)

  return new Uint8Array(Buffer.concat([...locals, central, eocd]))
}

/** A byte pattern that deflates well, for ratio and budget cases. */
export function compressible(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x41)
}
