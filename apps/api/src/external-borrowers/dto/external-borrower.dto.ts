import { Transform } from 'class-transformer'
import { Equals, IsString, MaxLength, MinLength } from 'class-validator'
import { EXTERNAL_BORROWER_LIMITS } from '@bookswap/shared'

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value

/** `POST /me/external-borrowers`. `ownerInformed` — заява власника, не підтвердження гостя. */
export class CreateExternalBorrowerDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Вкажіть аліас' })
  @MaxLength(EXTERNAL_BORROWER_LIMITS.aliasMax, { message: 'Аліас задовгий' })
  alias!: string

  @Equals(true, { message: 'Потрібна заява власника' })
  ownerInformed!: true
}

/** `PATCH /me/external-borrowers/:id`: у 10f.2 змінюється лише alias. */
export class UpdateExternalBorrowerDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1, { message: 'Вкажіть аліас' })
  @MaxLength(EXTERNAL_BORROWER_LIMITS.aliasMax, { message: 'Аліас задовгий' })
  alias!: string
}
