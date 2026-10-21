import { Transform } from 'class-transformer'
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator'
import {
  READING_LIST_LIMITS,
  READING_LIST_STATUS,
  READING_STATUS,
  READING_STATUS_BATCH_LIMITS,
  parseWorkIdList,
} from '@bookswap/shared'

/** `PUT /me/reading-statuses/:workId { status }`. Правила збігаються з `setReadingStatusRequestSchema`. */
export class SetReadingStatusDto {
  @IsIn(READING_STATUS, { message: 'Невідомий статус читання' })
  status!: (typeof READING_STATUS)[number]
}

/**
 * `GET /me/reading-list`. Query приходить рядками (`enableImplicitConversion: false`), тому `limit` —
 * рядок цілого 1…50, як і в `readingListQueryRequestSchema`. `NOT_READ` не є значенням фільтра.
 */
export class ReadingListQueryDto {
  @IsOptional()
  @IsIn(READING_LIST_STATUS, { message: 'Фільтр: READING або READ' })
  status?: (typeof READING_LIST_STATUS)[number]

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(READING_LIST_LIMITS.cursorMax)
  cursor?: string

  @IsOptional()
  @IsString()
  @Matches(/^[1-9]\d{0,2}$/, { message: 'limit — ціле число' })
  @Matches(/^([1-9]|[1-4]\d|50)$/, {
    message: `limit не більший за ${READING_LIST_LIMITS.pageMax}`,
  })
  limit?: string
}

/**
 * BS-140, `GET /me/reading-statuses?workIds=a,b,…`. Розбір — той самий `parseWorkIdList`, що й у
 * `readingStatusesQueryRequestSchema`: повтори зливаються, 1…100 унікальних ID. Масивом стає лише
 * правильний рядок: хибний рядок лишається рядком, а повторений параметр (він приходить масивом) чи
 * відсутній — `null`, і обидва відхиляє `@IsArray`.
 */
export class ReadingStatusesQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? (parseWorkIdList(value) ?? value) : null,
  )
  @IsArray({ message: READING_STATUS_BATCH_LIMITS.invalidMessage })
  @IsString({ each: true })
  workIds!: string[]
}
