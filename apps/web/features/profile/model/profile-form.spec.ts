import { PROFILE_LIMITS, type Me } from '@bookswap/shared'
import { validate } from '@/app/lib/validation'
import { profileFormSchema, toProfileFormValues, type ProfileFormValues } from './profile-form'

const me: Me = {
  id: 'user-1',
  email: 'reader@example.com',
  emailVerified: true,
  displayName: 'Марта',
  avatarUrl: null,
  bio: null,
  libraryVisibility: 'FRIENDS',
  showHolderNames: true,
  createdAt: '2026-01-01T00:00:00.000Z',
}

const draft = (overrides: Partial<ProfileFormValues> = {}): ProfileFormValues => ({
  ...toProfileFormValues(me),
  ...overrides,
})

/** What the resolver hands to submit: the `PATCH /me` body, or the first message per field. */
const parse = (values: ProfileFormValues) => validate(profileFormSchema, values)

describe('toProfileFormValues', () => {
  it('починає чернетку зі збереженого профілю, а відсутні аватар і біо стають порожніми полями', () => {
    expect(toProfileFormValues(me)).toEqual({
      displayName: 'Марта',
      avatarUrl: '',
      bio: '',
      libraryVisibility: 'FRIENDS',
      showHolderNames: true,
    })
  })

  it('переносить заповнені аватар і біо як є', () => {
    const filled = toProfileFormValues({
      ...me,
      avatarUrl: 'https://img.example/a.png',
      bio: 'Читаю',
    })

    expect(filled.avatarUrl).toBe('https://img.example/a.png')
    expect(filled.bio).toBe('Читаю')
  })
})

describe('profileFormSchema', () => {
  it('порожні аватар і біо надсилаються як null — це очищення поля', () => {
    expect(parse(draft({ avatarUrl: '   ', bio: '  ' }))).toEqual({
      ok: true,
      data: {
        displayName: 'Марта',
        avatarUrl: null,
        bio: null,
        libraryVisibility: 'FRIENDS',
        showHolderNames: true,
      },
    })
  })

  it('обрізає пробіли навколо імені, посилання й біо', () => {
    const result = parse(
      draft({ displayName: '  Марта К ', avatarUrl: ' https://img.example/a.png ', bio: ' Біо ' }),
    )

    expect(result).toMatchObject({
      ok: true,
      data: { displayName: 'Марта К', avatarUrl: 'https://img.example/a.png', bio: 'Біо' },
    })
  })

  it('надсилає всі пʼять редагованих полів, включно з налаштуваннями приватності', () => {
    const result = parse(draft({ libraryVisibility: 'PRIVATE', showHolderNames: false }))

    expect(result).toMatchObject({
      ok: true,
      data: { libraryVisibility: 'PRIVATE', showHolderNames: false },
    })
  })

  it('відхиляє закоротке імʼя, некоректне посилання й задовге біо з повідомленнями спільної схеми', () => {
    const result = parse(
      draft({
        displayName: 'М',
        avatarUrl: 'не посилання',
        bio: 'б'.repeat(PROFILE_LIMITS.bioMax + 1),
      }),
    )

    expect(result).toEqual({
      ok: false,
      errors: {
        displayName: 'Імʼя закоротке',
        avatarUrl: 'Некоректне посилання',
        bio: 'Біо задовге',
      },
    })
  })
})
