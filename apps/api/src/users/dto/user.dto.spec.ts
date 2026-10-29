import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validateSync } from 'class-validator'
import { handleSchema, updateProfileRequestSchema } from '@bookswap/shared'
import { HandleParamDto, UpdateProfileDto } from './user.dto'

/**
 * The same parity test as for the other DTOs (§11): the DTO and the shared schema accept and refuse
 * the same bodies. Only the nickname and city cases are listed — the fields BS-148 added.
 *
 * One known difference is outside this test: the shared schema refuses an empty body, the DTO
 * leaves that to the controller (a rule about the set of fields, not about a field).
 */
function acceptedByDto<T extends object>(dto: new () => T, payload: unknown): boolean {
  const instance = plainToInstance(dto, payload)

  return validateSync(instance, { whitelist: true, forbidNonWhitelisted: true }).length === 0
}

describe('UpdateProfileDto ↔ updateProfileRequestSchema (BS-148)', () => {
  const cases: { name: string; payload: unknown }[] = [
    { name: 'нік', payload: { handle: 'danylo-ohurtsov' } },
    { name: 'нік з пробілами й великими літерами', payload: { handle: '  Danylo_2 ' } },
    { name: 'нік 30 символів', payload: { handle: 'a'.repeat(30) } },
    { name: 'нік 31 символ', payload: { handle: 'a'.repeat(31) } },
    { name: 'нік 2 символи', payload: { handle: 'ab' } },
    { name: 'нік з краєвим дефісом', payload: { handle: '-abc' } },
    { name: 'нік з двома роздільниками підряд', payload: { handle: 'ab_-cd' } },
    { name: 'нік кирилицею', payload: { handle: 'данило' } },
    { name: 'нік null', payload: { handle: null } },
    { name: 'нік числом', payload: { handle: 12345 } },
    { name: 'місто', payload: { city: '  Вроцлав ' } },
    { name: 'місто null', payload: { city: null } },
    { name: 'місто з самих пробілів', payload: { city: '   ' } },
    { name: 'місто 60 символів', payload: { city: 'м'.repeat(60) } },
    { name: 'місто 61 символ', payload: { city: 'м'.repeat(61) } },
  ]

  it.each(cases)('$name — однаковий вердикт', ({ payload }) => {
    expect(acceptedByDto(UpdateProfileDto, payload)).toBe(
      updateProfileRequestSchema.safeParse(payload).success,
    )
  })

  it('нормалізує нік так само, як схема', () => {
    const instance = plainToInstance(UpdateProfileDto, { handle: '  Danylo_2 ' })

    expect(instance.handle).toBe(handleSchema.parse('  Danylo_2 '))
  })

  it('зводить порожнє місто до null, як схема', () => {
    const instance = plainToInstance(UpdateProfileDto, { city: '   ' })

    expect(instance.city).toBeNull()
    expect(updateProfileRequestSchema.parse({ city: '   ' })).toEqual({ city: null })
  })
})

describe('HandleParamDto ↔ handleSchema (BS-148)', () => {
  it.each(['danylo', 'Danylo', 'ab', 'a--b', 'a'.repeat(31)])(
    '%p — однаковий вердикт',
    (handle) => {
      expect(acceptedByDto(HandleParamDto, { handle })).toBe(handleSchema.safeParse(handle).success)
    },
  )
})
