/**
 * BS-147: the pastel behind a person's initials when they have no photo (canvas «Main Page»). The
 * light pairs are the canvas's own; each dark pair darkens the light text towards the canvas's dark
 * surface and writes in the light background. Every pair keeps its initials at 4.5:1 or better.
 */
export const AVATAR_PALETTE = [
  {
    name: 'coral',
    light: { background: '#FDE7E2', foreground: '#8A3A2C' },
    dark: { background: '#5A3127', foreground: '#FDE7E2' },
  },
  {
    name: 'teal',
    light: { background: '#E2EEF0', foreground: '#245B63' },
    dark: { background: '#224345', foreground: '#E2EEF0' },
  },
  {
    name: 'lavender',
    light: { background: '#ECE2F2', foreground: '#5E3B78' },
    dark: { background: '#423251', foreground: '#ECE2F2' },
  },
  {
    name: 'sand',
    light: { background: '#F4E6D6', foreground: '#7A4A1E' },
    dark: { background: '#523A1F', foreground: '#F4E6D6' },
  },
  {
    name: 'olive',
    light: { background: '#E8EBDD', foreground: '#4E5A23' },
    dark: { background: '#394322', foreground: '#E8EBDD' },
  },
  {
    name: 'blue',
    light: { background: '#DFE9F5', foreground: '#2C5683' },
    dark: { background: '#274057', foreground: '#DFE9F5' },
  },
  {
    name: 'rose',
    light: { background: '#F3E1EA', foreground: '#7A2F55' },
    dark: { background: '#522B3E', foreground: '#F3E1EA' },
  },
  {
    name: 'green',
    light: { background: '#E3EFE6', foreground: '#286747' },
    dark: { background: '#244A36', foreground: '#E3EFE6' },
  },
] as const

export type AvatarColours = (typeof AVATAR_PALETTE)[number]

/** The letters the canvas draws, with its colours: «Ірина» is coral, «Тарас» teal, as there. */
const CANVAS_LETTERS: Record<string, AvatarColours['name']> = {
  І: 'coral',
  Т: 'teal',
  О: 'lavender',
  Л: 'sand',
  С: 'olive',
  А: 'blue',
  В: 'rose',
  М: 'green',
}

/**
 * The colours of a person's avatar, picked by the first letter of their name: the same letter is the
 * same colour on every card, reload and theme. A letter the canvas does not draw takes its place by code
 * point, so the rest of the alphabet spreads across the palette.
 */
export function avatarColoursFor(displayName: string): AvatarColours {
  const letter = (Array.from(displayName.trim())[0] ?? '').toLocaleUpperCase('uk-UA')
  const named = CANVAS_LETTERS[letter]

  if (named !== undefined)
    return AVATAR_PALETTE.find((colours) => colours.name === named) ?? AVATAR_PALETTE[0]

  return AVATAR_PALETTE[(letter.codePointAt(0) ?? 0) % AVATAR_PALETTE.length] ?? AVATAR_PALETTE[0]
}
