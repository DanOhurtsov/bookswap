import { Type } from 'class-transformer'
import {
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  registerDecorator,
  ValidateIf,
  type ValidationArguments,
} from 'class-validator'
import {
  CATALOG_LIMITS,
  LIBRARY_IMPORT_CONTENT_BASE64_MAX,
  LIBRARY_IMPORT_CSV_HEADER,
  LIBRARY_IMPORT_LIMITS,
  LIBRARY_IMPORT_ROW_ACTION,
  type LibraryImportRowAction,
} from '@bookswap/shared'

/**
 * Stage 8f-2, §11: the class-validator half of the CSV import contract. The zod
 * half lives in `packages/shared`; `library-import.dto.spec.ts` holds the two
 * to the same verdicts rather than to the same source.
 */

/** Standard padded base64 only — the same expression the shared schema enforces. */
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const COLUMNS = new Set<string>(LIBRARY_IMPORT_CSV_HEADER)

/** Mirrors `libraryImportRowVersionSchema`. */
const ROW_VERSION_MAX = 64

export class LibraryImportPreviewDto {
  @IsString()
  @MinLength(1, { message: 'Файл порожній' })
  @MaxLength(LIBRARY_IMPORT_CONTENT_BASE64_MAX, { message: 'Файл завеликий' })
  @IsBase64Content()
  contentBase64!: string
}

export class LibraryImportRowParamsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(CATALOG_LIMITS.idMax)
  id!: string

  /**
   * Only a row number a file could have; anything else never reaches the
   * service. `@Type` is required — implicit conversion is off globally, and a
   * path segment arrives as a string.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LIBRARY_IMPORT_LIMITS.maxDataRows)
  rowNumber!: number
}

/**
 * One body for every row action, the shape checked per action.
 *
 * A field belonging to another action is rejected rather than ignored: silently
 * dropping `workId` from a `SKIP` would answer 200 to a request the server did
 * not actually carry out.
 */
export class LibraryImportRowPatchDto {
  @IsIn(LIBRARY_IMPORT_ROW_ACTION, { message: 'Невідома дія над рядком' })
  @OnlyFieldsOfAction()
  action!: LibraryImportRowAction

  /**
   * Which state of the row this action was decided on (agreed 8f-2 concurrency
   * contract). Required for every action, including the ones that make no
   * external call: the question is which row the person meant, not how long the
   * server took.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(ROW_VERSION_MAX)
  expectedRowVersion!: string

  @ValidateIf((dto: LibraryImportRowPatchDto) => dto.action === 'EDIT')
  @IsObject()
  @IsEditableCells()
  cells?: Record<string, string>

  @ValidateIf((dto: LibraryImportRowPatchDto) => dto.action === 'CHOOSE')
  @IsWorkChoice()
  workId?: string | null
}

function IsBase64Content(): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isBase64Content',
      target: object.constructor,
      propertyName: String(propertyName),
      options: { message: 'Очікується стандартний base64 без пробілів і префіксів' },
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && value.length % 4 === 0 && BASE64_PATTERN.test(value),
      },
    })
  }
}

/** Every key is a real CSV column, every value a string, and at least one of them. */
function IsEditableCells(): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isEditableCells',
      target: object.constructor,
      propertyName: String(propertyName),
      options: { message: 'Очікується набір клітинок CSV для зміни' },
      validator: {
        validate: (value: unknown) => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

          const entries = Object.entries(value)

          return (
            entries.length > 0 &&
            entries.every(
              ([column, cell]) =>
                COLUMNS.has(column) &&
                typeof cell === 'string' &&
                cell.length <= LIBRARY_IMPORT_LIMITS.maxBytes,
            )
          )
        },
      },
    })
  }
}

/** `null` is meaningful here — "create a new work" — so it is not "absent". */
function IsWorkChoice(): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isWorkChoice',
      target: object.constructor,
      propertyName: String(propertyName),
      options: { message: 'Очікується id твору або null' },
      validator: {
        validate: (value: unknown) =>
          value === null || (typeof value === 'string' && value.length > 0),
      },
    })
  }
}

const FIELDS_BY_ACTION: Readonly<Record<LibraryImportRowAction, readonly string[]>> = {
  EDIT: ['cells'],
  CHOOSE: ['workId'],
  SKIP: [],
  RESTORE: [],
  RETRY: [],
}

/** Rejects a field that belongs to a different action — the discriminated union, enforced. */
function OnlyFieldsOfAction(): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'onlyFieldsOfAction',
      target: object.constructor,
      propertyName: String(propertyName),
      options: { message: 'Поле не належить цій дії над рядком' },
      validator: {
        validate: (_value: unknown, args: ValidationArguments) => {
          const dto = args.object as LibraryImportRowPatchDto
          const allowed = FIELDS_BY_ACTION[dto.action] as readonly string[] | undefined

          if (allowed === undefined) return true

          // `field in dto` would always hold: a declared class field exists on
          // the instance as `undefined` even when the body never mentioned it.
          // What matters is whether a value actually arrived.
          const given = dto as unknown as Record<string, unknown>

          return ['cells', 'workId'].every(
            (field) => allowed.includes(field) || given[field] === undefined,
          )
        },
      },
    })
  }
}
