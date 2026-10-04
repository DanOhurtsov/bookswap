import { registerDecorator, ValidateIf, type ValidationOptions } from 'class-validator'
import { isLanguageCode, isValidIsbn13 } from '@bookswap/shared'
import type { ZodType } from 'zod'

/**
 * Декоратори `class-validator`, побудовані **поверх** предикатів зі `shared`.
 *
 * §11 вимагає обидва механізми валідації — zod для контракту й class-validator
 * для DTO, — але саме правило дублювати не можна. Контрольну суму ISBN чи
 * перелік кодів ISO 639-1, переписані вдруге, розійшлися б із першою ж правкою,
 * і жоден тест парності цього б не побачив: він порівнює вироки, а не джерела.
 * Тому декоратори тонкі — вони лише підключають той самий предикат.
 */

/** Значення, які `@IsOptional()` пропускає: «не передали» і «прибрати». */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

/**
 * Stage 8e-1: «поле PATCH — необов'язкове, але НЕ nullable».
 *
 * `@IsOptional()` (як і `isAbsent` вище) трактує `null` так само, як
 * `undefined`, і глушить решту валідаторів для обох. Для полів на кшталт
 * `title`/`origLang`/`authors`, де omitted = «без змін», а `null` заборонений
 * контрактом (zod `.partial()` додає лише `| undefined`, не `| null`), це дало
 * б розбіжність DTO ↔ zod: DTO мовчки пропустив би `null`, схема — впала.
 *
 * `@ValidateIf` пропускає решту декораторів лише для `undefined`; на `null`
 * (і на будь-яке інше значення) звичайні валідатори виконуються — і `null` їм
 * не подобається (`@IsString(null)` тощо), тож він падає саме там, де й
 * повинен.
 */
export function IsOptionalNotNull(): PropertyDecorator {
  return ValidateIf((_object: object, value: unknown) => value !== undefined)
}

export function IsLanguageCode(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isLanguageCode',
      target: object.constructor,
      propertyName,
      options: {
        message: 'Невідомий код мови — потрібен ISO 639-1, напр. «uk» або «en»',
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isLanguageCode(value),
      },
    })
  }
}

export function IsIsbn13(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isIsbn13',
      target: object.constructor,
      propertyName,
      options: { message: 'Некоректний ISBN-13: не сходиться контрольна сума', ...options },
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isValidIsbn13(value),
      },
    })
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Календарна дата без часу — те саме, що `z.iso.date()`.
 *
 * Перевіряється не лише формат, а й існування дати: `new Date('2026-02-31')` мовчки
 * стає 3 березня, тож єдиний надійний спосіб — звірити зворотне перетворення.
 * Без цього «31 лютого» доїхало б до БД як інший день.
 */
export function isIsoDate(value: unknown): boolean {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false

  const parsed = new Date(`${value}T00:00:00.000Z`)

  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

export function IsIsoDate(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isIsoDate',
      target: object.constructor,
      propertyName,
      options: { message: 'Потрібна дата у форматі РРРР-ММ-ДД', ...options },
      validator: { validate: isIsoDate },
    })
  }
}

/**
 * Клітинка матриці §7.6 названа рівно один раз.
 *
 * Теж висить на масиві, а не на елементі: правило про **набір**, а не про окремий
 * рядок. Дублікат — це 400, а не «перемагає останній»: два різні значення однієї
 * клітинки в одному тілі означають, що клієнт зібрав форму неправильно, і
 * зберегти будь-яке з них — зберегти не те, що людина бачила на екрані.
 */
export function EachPreferenceCellOnce(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'eachPreferenceCellOnce',
      target: object.constructor,
      propertyName,
      options: { message: 'Одна клітинка матриці згадана двічі', ...options },
      validator: {
        validate: (value: unknown) => {
          if (!Array.isArray(value)) return false

          const cells = value.map((item) => {
            if (typeof item !== 'object' || item === null) return ''

            const { type, channel } = item as { type?: unknown; channel?: unknown }

            return `${String(type)}:${String(channel)}`
          })

          return new Set(cells).size === cells.length
        },
      },
    })
  }
}

/**
 * Правило про **пару** полів усередині елемента масиву: автор задається або
 * `authorId`, або `name`, і ніколи обома.
 *
 * Висить на самому масиві, а не на його елементах, і це вимушено: `@IsOptional()`
 * на властивості глушить усі інші валідатори тієї ж властивості, тож на
 * `authorId` чи `name` така перевірка просто не спрацювала б.
 */
export function EachAuthorHasOneSource(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'eachAuthorHasOneSource',
      target: object.constructor,
      propertyName,
      options: {
        message: 'Потрібен або authorId наявного автора, або name нового — рівно одне з двох',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          Array.isArray(value) &&
          value.every((item) => {
            if (typeof item !== 'object' || item === null) return false

            const { authorId, name } = item as { authorId?: unknown; name?: unknown }

            return isAbsent(authorId) !== isAbsent(name)
          }),
      },
    })
  }
}

/**
 * PO decision (Stage 8e-2, R10a): `authorId` (existing author) and `nameLatin`
 * are mutually exclusive on one PATCH `authors` element — REJECTED, even when
 * `nameLatin` is explicitly `null`. Parity-tested against
 * `authorIdExcludesNameLatin` (`@bookswap/shared`, `catalog-correction.ts`);
 * PATCH-only, so this decorator goes on `PatchWorkDto.authors`, never on
 * `CreateWorkDto.authors` (`WorkAuthorInputDto` itself stays shared and
 * unchanged — see `EachAuthorHasOneSource` above for why the check lives on
 * the array, not the element's own properties).
 */
export function EachAuthorIdExcludesNameLatin(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'eachAuthorIdExcludesNameLatin',
      target: object.constructor,
      propertyName,
      options: {
        message:
          'nameLatin не редагує транслітерацію наявного автора — вкажіть його лише для нового автора (без authorId)',
        ...options,
      },
      validator: {
        validate: (value: unknown) =>
          Array.isArray(value) &&
          value.every((item) => {
            if (typeof item !== 'object' || item === null) return false

            const { authorId, nameLatin } = item as { authorId?: unknown; nameLatin?: unknown }

            return authorId === undefined || nameLatin === undefined
          }),
      },
    })
  }
}

/**
 * Поле, яке цілком описує спільна zod-схема (`packages/shared`).
 *
 * Для вкладених дискримінованих форм (`target` швидкого додавання) повторювати правила
 * вручну в `class-validator` означало б другу копію, що розходиться з першою; тут правило
 * одне, і DTO лишається runtime-валідованим (§11). Розбіжності з контрактом бути не може:
 * вирок виносить той самий `safeParse`, що й у клієнтській валідації.
 */
export function IsZodSchema(schema: ZodType, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isZodSchema',
      target: object.constructor,
      propertyName,
      options: { message: 'Значення не відповідає контракту', ...options },
      validator: { validate: (value: unknown) => schema.safeParse(value).success },
    })
  }
}
