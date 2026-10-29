import { PROFILE_LIMITS, type Me } from '@bookswap/shared'
import { ApiRequestError } from '@/app/lib/api'
import { validate } from '@/app/lib/validation'
import {
  NAME_REQUIRED_MESSAGE,
  normalizeHandleInput,
  profileChanges,
  profileFormSchema,
  saveFailureOf,
  toProfileFormValues,
  type ProfileFormValues,
} from './profile-form'

const me: Me = {
  id: 'user-1',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Марта',
  handle: 'reader',
  city: null,
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  friendsOfFriendsAccess: false,
  loanRequestsPaused: false,
  defaultLoanTermDays: null,
  ownerDueReminders: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const draft = (overrides: Partial<ProfileFormValues> = {}): ProfileFormValues => ({
  ...toProfileFormValues(me),
  ...overrides,
})

/** What the resolver hands to submit: the saved shape, or the first message per field. */
const parse = (values: ProfileFormValues) => validate(profileFormSchema, values)

/** The `PATCH /me` body a valid draft turns into. */
function changesOf(values: ProfileFormValues, saved: Me = me) {
  const result = parse(values)

  if (!result.ok) throw new Error(JSON.stringify(result.errors))

  return profileChanges(result.data, saved)
}

describe('toProfileFormValues', () => {
  it('починає чернетку зі збереженого профілю; відсутні місто й біо стають порожніми полями, фото в чернетці немає', () => {
    expect(toProfileFormValues({ ...me, avatarUrl: 'https://img.example/a.png' })).toEqual({
      displayName: 'Марта',
      handle: 'reader',
      city: '',
      bio: '',
    })
  })

  it('переносить заповнені місто й біо як є', () => {
    expect(toProfileFormValues({ ...me, city: 'Вроцлав', bio: 'Читаю' })).toMatchObject({
      city: 'Вроцлав',
      bio: 'Читаю',
    })
  })
})

describe('profileFormSchema', () => {
  it('обрізає пробіли; порожні місто й біо стають null — це очищення поля', () => {
    expect(parse(draft({ displayName: '  Марта К ', city: '  ', bio: ' ' }))).toEqual({
      ok: true,
      data: { displayName: 'Марта К', handle: 'reader', city: null, bio: null },
    })
  })

  it('порожнє чи закоротке імʼя просить словами макета, задовге — повідомленням спільної схеми', () => {
    expect(parse(draft({ displayName: '  ' }))).toMatchObject({
      ok: false,
      errors: { displayName: NAME_REQUIRED_MESSAGE },
    })
    expect(parse(draft({ displayName: 'М' }))).toMatchObject({
      ok: false,
      errors: { displayName: NAME_REQUIRED_MESSAGE },
    })
    expect(
      parse(draft({ displayName: 'М'.repeat(PROFILE_LIMITS.displayNameMax + 1) })),
    ).toMatchObject({ ok: false, errors: { displayName: 'Імʼя задовге' } })
  })

  it('нік і біо — за правилами спільної схеми', () => {
    expect(parse(draft({ handle: 'ab', bio: 'б'.repeat(PROFILE_LIMITS.bioMax + 1) }))).toEqual({
      ok: false,
      errors: {
        handle: 'Лише латинські літери, цифри, - та _, від 3 до 30 символів',
        bio: 'Біо задовге',
      },
    })
  })
})

describe('profileChanges', () => {
  it('надсилає лише змінені поля', () => {
    expect(changesOf(draft({ city: 'Вроцлав' }))).toEqual({ city: 'Вроцлав' })
    expect(changesOf(draft({ handle: 'marta', bio: 'Читаю' }))).toEqual({
      handle: 'marta',
      bio: 'Читаю',
    })
  })

  it('пробіл, доданий до імені, — не зміна; нічого не змінено — null', () => {
    expect(changesOf(draft({ displayName: 'Марта ' }))).toBeNull()
    expect(changesOf(draft())).toBeNull()
  })

  it('очищене місто й біо надсилаються як null', () => {
    expect(
      changesOf(draft({ city: '', bio: '' }), { ...me, city: 'Вроцлав', bio: 'Читаю' }),
    ).toEqual({ city: null, bio: null })
  })
})

describe('normalizeHandleInput', () => {
  it('нижній регістр і без пробілів — як у полі макета', () => {
    expect(normalizeHandleInput(' Marta Reads ')).toBe('martareads')
  })
})

describe('saveFailureOf', () => {
  it('зайнятий нік — під полем ніка', () => {
    expect(
      saveFailureOf(
        new ApiRequestError(409, { code: 'HANDLE_TAKEN', message: 'Цей нік уже зайнятий' }),
      ),
    ).toEqual({ kind: 'handle', message: 'Цей нік уже зайнятий' })
  })

  it('інша відповідь сервера про запит — над полями як є', () => {
    const error = new ApiRequestError(400, {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
    })

    expect(saveFailureOf(error)).toEqual({ kind: 'request', error })
  })

  it('5xx, мережа й таймаут — банер зі «Спробувати ще»', () => {
    expect(
      saveFailureOf(new ApiRequestError(503, { code: 'INTERNAL_ERROR', message: 'Збій' })),
    ).toEqual({ kind: 'connection' })
    expect(saveFailureOf(new TypeError('Failed to fetch'))).toEqual({ kind: 'connection' })
    expect(saveFailureOf(new DOMException('timed out', 'TimeoutError'))).toEqual({
      kind: 'connection',
    })
  })
})
