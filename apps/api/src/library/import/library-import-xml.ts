import { SaxesParser, type SaxesOptions } from 'saxes'

/**
 * Stage 8f-4: a bounded XML read of one already-verified OOXML part.
 *
 * **Why a parser and not a substring search.** The checks that hang off this —
 * external workbook links, macro content types — decide whether a file is
 * refused, so they have to see what a consumer would see. `TargetMode="External"`,
 * `TargetMode='External'`, `TargetMode = "External"` and
 * `Type="…extern&#97;lLink"` are one and the same declaration to every XML
 * reader on earth, and four different strings to `includes()`. Matching text
 * would refuse the spelling we happened to think of and wave through the rest.
 *
 * **What it refuses to do.** Nothing is fetched: saxes has no notion of
 * retrieving anything, and a part carrying a `DOCTYPE` is rejected outright
 * rather than reasoned about — an OOXML part has no legitimate use for one, and
 * refusing it closes the entity-expansion questions (external entities, billion
 * laughs) instead of relying on a parser's restraint. saxes does not expand
 * declared entities in any case; it reports them as undefined.
 *
 * **Bounded.** Bytes are decoded and fed in chunks, and the loop stops the
 * moment the visitor says it has seen enough. That is what makes a budget
 * meaningful: a cell count that stops at the cap does not first parse the eight
 * megabytes behind it.
 */

type PlainXml = SaxesOptions & { xmlns?: false }

export interface XmlElement {
  name: string
  /** Attribute values as XML defines them: quotes stripped, references resolved. */
  attributes: Record<string, string>
}

/** `true` from the visitor stops the scan where it stands. */
export type XmlVisitor = (element: XmlElement) => boolean

export type XmlScanOutcome =
  | 'ok'
  /** The visitor asked to stop; whatever it was looking for, it found. */
  | 'stopped'
  /** Not valid UTF-8, not well-formed XML, or carrying a DOCTYPE. */
  | 'rejected'

const CHUNK_BYTES = 64 * 1024

export function scanXml(bytes: Uint8Array, visit: XmlVisitor): XmlScanOutcome {
  // Namespace processing off (the default), which is what makes an attribute
  // value a plain string rather than a namespace record.
  const parser = new SaxesParser<PlainXml>({ fragment: false })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let outcome: XmlScanOutcome = 'ok'

  parser.on('error', () => {
    outcome = 'rejected'
  })
  parser.on('doctype', () => {
    outcome = 'rejected'
  })
  parser.on('opentag', (tag) => {
    if (outcome !== 'ok') return
    if (visit({ name: tag.name, attributes: { ...tag.attributes } })) outcome = 'stopped'
  })

  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const last = offset + CHUNK_BYTES >= bytes.byteLength

    try {
      // Streaming decode, so a multi-byte character split across two chunks is
      // joined rather than turned into a decode failure.
      parser.write(decoder.decode(bytes.subarray(offset, offset + CHUNK_BYTES), { stream: !last }))
    } catch {
      return 'rejected'
    }

    // Checked between chunks, not after the document: this is the early exit.
    if (outcome !== 'ok') return outcome
  }

  try {
    parser.close()
  } catch {
    return 'rejected'
  }

  return outcome
}

/**
 * One attribute, looked up without regard to case.
 *
 * XML itself is case-sensitive, and a workbook Excel wrote spells these exactly
 * one way. Reading them loosely only ever widens what we refuse, which is the
 * safe direction for a check whose answer is "no".
 */
export function attribute(element: XmlElement, name: string): string | undefined {
  const wanted = name.toLowerCase()

  for (const [key, value] of Object.entries(element.attributes)) {
    if (key.toLowerCase() === wanted) return value.trim()
  }

  return undefined
}
