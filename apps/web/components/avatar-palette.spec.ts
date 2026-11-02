import { AVATAR_PALETTE, avatarColoursFor } from './avatar-palette'

/** WCAG relative luminance of a `#RRGGBB` colour. */
function luminance(hex: string): number {
  const [red, green, blue] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05)
}

describe('avatarColoursFor', () => {
  it('літери макета мають кольори макета', () => {
    expect(avatarColoursFor('Ірина').name).toBe('coral')
    expect(avatarColoursFor('Тарас').name).toBe('teal')
    expect(avatarColoursFor('Оксана').name).toBe('lavender')
    expect(avatarColoursFor('Марко').name).toBe('green')
  })

  it('колір дає лише перша літера імені, незалежно від регістру й пробілів', () => {
    expect(avatarColoursFor('  ірина петрівна')).toBe(avatarColoursFor('Іван'))
    expect(avatarColoursFor('Юлія')).toBe(avatarColoursFor('Юрій'))
    expect(avatarColoursFor('zoe')).toBe(avatarColoursFor('Zack'))
  })

  it('решта абетки розходиться по всій палітрі', () => {
    const used = new Set(
      Array.from('АБВГҐДЕЄЖЗИІЇЙКЛМНОПРСТУФХЦЧШЩЬЮЯ', (letter) => avatarColoursFor(letter).name),
    )

    expect(used.size).toBe(AVATAR_PALETTE.length)
  })

  it('порожнє ім’я чи емодзі теж мають колір', () => {
    expect(AVATAR_PALETTE).toContain(avatarColoursFor(''))
    expect(AVATAR_PALETTE).toContain(avatarColoursFor('📚 Читач'))
  })

  it.each(AVATAR_PALETTE.map((colours) => [colours.name, colours] as const))(
    'ініціали «%s» читаються в обох темах (4.5:1 і краще)',
    (_name, colours) => {
      expect(contrast(colours.light.background, colours.light.foreground)).toBeGreaterThanOrEqual(
        4.5,
      )
      expect(contrast(colours.dark.background, colours.dark.foreground)).toBeGreaterThanOrEqual(4.5)
    },
  )
})
