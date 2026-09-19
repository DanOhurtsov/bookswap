import { LIBRARY_IMPORT_XLSX_LIMITS } from '@bookswap/shared'
import { invalidXlsx, tooLargeXlsx, type XlsxFailure } from './library-import-xlsx.errors'
import { attribute, scanXml, type XmlElement } from './library-import-xml'

/**
 * Stage 8f-4: what the verified OOXML parts say about themselves, read before
 * ExcelJS is handed anything.
 *
 * Two jobs, one technique. The first is the manifest: a workbook that declares
 * macros or reaches out to another file is refused whatever its parts contain.
 * The second is size: how many sheets, rows and cells the markup actually
 * defines — because `Workbook.xlsx.load()` builds the entire object graph in
 * one call, so a limit checked after it has already been paid for.
 *
 * Neither job trusts `<dimension ref="A1:XFD1048576"/>`. A sheet may claim any
 * rectangle it likes; nothing here walks it, and the counts below come only
 * from elements that are really present.
 */

const MACRO_MARKERS = ['macroenabled', 'vbaproject', 'ms-excel.addin']

const EXTERNAL_LINK_TYPE = '/externallink'

const WORKBOOK_PART = 'xl/workbook.xml'

const SHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/

/** Excel's own grid. A reference outside it is not a cell any reader could place. */
const MAX_SHEET_ROW = 1_048_576
const MAX_SHEET_COLUMN = 16_384

const CELL_REFERENCE = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/

type Declaration = 'MACRO_ENABLED' | 'EXTERNAL_LINKS'

/**
 * A macro or an external link, as the XML actually declares it.
 *
 * Relationship `Type` and `TargetMode` and content-type `ContentType` are read
 * as parsed attribute values, so quoting style, spacing and character
 * references cannot hide any of them.
 */
function declarationOf(element: XmlElement): Declaration | undefined {
  const contentType = attribute(element, 'ContentType')?.toLowerCase()
  const type = attribute(element, 'Type')?.toLowerCase()

  for (const value of [contentType, type]) {
    if (value !== undefined && MACRO_MARKERS.some((marker) => value.includes(marker))) {
      return 'MACRO_ENABLED'
    }
  }

  if (type?.includes(EXTERNAL_LINK_TYPE) === true) return 'EXTERNAL_LINKS'
  if (attribute(element, 'TargetMode')?.toLowerCase() === 'external') return 'EXTERNAL_LINKS'

  return undefined
}

/** The package manifest and every relationship file, checked as XML. */
export function checkOoxmlDeclarations(
  parts: ReadonlyMap<string, Uint8Array>,
): XlsxFailure | undefined {
  for (const [name, bytes] of parts) {
    if (!name.endsWith('.rels') && name !== '[Content_Types].xml') continue

    let found: Declaration | undefined
    const outcome = scanXml(bytes, (element) => {
      found = declarationOf(element)

      return found !== undefined
    })

    if (outcome === 'rejected') return invalidXlsx({ reason: 'MALFORMED_XLSX' })
    if (found !== undefined) return invalidXlsx({ reason: found })
  }

  return undefined
}

function countSheets(bytes: Uint8Array): number | XlsxFailure {
  let sheets = 0
  // Counted to the end rather than stopped at the cap: a workbook part is one
  // small file, and the honest total is what the message should carry.
  const outcome = scanXml(bytes, (element) => {
    if (element.name === 'sheet') sheets += 1

    return false
  })

  if (outcome === 'rejected') return invalidXlsx({ reason: 'MALFORMED_XLSX' })

  return sheets
}

interface SheetBudget {
  rows: number
  cells: number
  overRows: boolean
  overCells: boolean
  unsafeReference: boolean
}

/** A row or cell reference outside Excel's grid, or shaped like nothing at all. */
function isUnsafeReference(element: XmlElement): boolean {
  if (element.name === 'row') {
    const reference = attribute(element, 'r')

    if (reference === undefined) return false

    return !/^[1-9][0-9]{0,7}$/.test(reference) || Number(reference) > MAX_SHEET_ROW
  }

  const reference = attribute(element, 'r')

  if (reference === undefined) return false

  const match = CELL_REFERENCE.exec(reference)

  if (match === null) return true

  const letters = match[1] ?? ''
  let column = 0

  for (const letter of letters) column = column * 26 + (letter.charCodeAt(0) - 64)

  return column > MAX_SHEET_COLUMN || Number(match[2]) > MAX_SHEET_ROW
}

/**
 * Walks one sheet's markup, stopping the instant a budget is spent.
 *
 * `<row>` is counted whether or not it holds values: an empty row still becomes
 * an object in the reader, which is the cost this bounds.
 */
function measureSheet(bytes: Uint8Array): SheetBudget | XlsxFailure {
  const budget: SheetBudget = {
    rows: 0,
    cells: 0,
    overRows: false,
    overCells: false,
    unsafeReference: false,
  }

  const outcome = scanXml(bytes, (element) => {
    if (element.name !== 'row' && element.name !== 'c') return false

    if (isUnsafeReference(element)) {
      budget.unsafeReference = true

      return true
    }

    if (element.name === 'row') {
      budget.rows += 1
      budget.overRows = budget.rows > LIBRARY_IMPORT_XLSX_LIMITS.maxSheetRows
    } else {
      budget.cells += 1
      budget.overCells = budget.cells > LIBRARY_IMPORT_XLSX_LIMITS.maxCells
    }

    return budget.overRows || budget.overCells
  })

  return outcome === 'rejected' ? invalidXlsx({ reason: 'MALFORMED_XLSX' }) : budget
}

function sheetFailure(budget: SheetBudget): XlsxFailure | undefined {
  if (budget.unsafeReference) return invalidXlsx({ reason: 'MALFORMED_XLSX' })

  if (budget.overRows) {
    return tooLargeXlsx({
      limit: 'SHEET_ROWS',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxSheetRows,
      actual: budget.rows,
    })
  }

  return budget.overCells
    ? tooLargeXlsx({
        limit: 'CELLS',
        max: LIBRARY_IMPORT_XLSX_LIMITS.maxCells,
        actual: budget.cells,
      })
    : undefined
}

/**
 * Every structural limit that can be known from the markup — and all of them
 * are, so that a workbook past any of them is refused without ExcelJS ever
 * being asked to build it.
 */
export function inspectWorkbookStructure(
  parts: ReadonlyMap<string, Uint8Array>,
): XlsxFailure | undefined {
  const workbook = parts.get(WORKBOOK_PART)

  if (workbook === undefined) return invalidXlsx({ reason: 'MALFORMED_XLSX' })

  const sheets = countSheets(workbook)

  if (typeof sheets !== 'number') return sheets

  if (sheets > LIBRARY_IMPORT_XLSX_LIMITS.maxSheets) {
    return tooLargeXlsx({
      limit: 'SHEETS',
      max: LIBRARY_IMPORT_XLSX_LIMITS.maxSheets,
      actual: sheets,
    })
  }

  for (const [name, bytes] of parts) {
    if (!SHEET_PART.test(name)) continue

    const budget = measureSheet(bytes)

    if (!('rows' in budget)) return budget

    const failure = sheetFailure(budget)

    if (failure !== undefined) return failure
  }

  return undefined
}
