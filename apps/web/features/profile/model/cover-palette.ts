/**
 * BS-148: the colours of a cover drawn for a book without a picture (canvas «Profile Page»). Each pair
 * keeps its text at 4.5:1 or better in both themes. Two light pairs differ from the brief by a shade
 * to get there: terracotta's background (#A65F4B → #985644) and dusty-blue's text (#142330 → #08121A).
 */
export const COVER_PALETTE = [
  {
    name: 'slate',
    light: { background: '#2F3B4C', foreground: '#F2EEE6' },
    dark: { background: '#35465C', foreground: '#F2EEE6' },
  },
  {
    name: 'olive',
    light: { background: '#4F6B3A', foreground: '#F3EFE2' },
    dark: { background: '#465C36', foreground: '#F3EFE2' },
  },
  {
    name: 'sand',
    light: { background: '#D9A35A', foreground: '#3A2410' },
    dark: { background: '#785B36', foreground: '#FFF0D9' },
  },
  {
    name: 'plum',
    light: { background: '#3B2A4A', foreground: '#F3E9D8' },
    dark: { background: '#594365', foreground: '#F5EAF8' },
  },
  {
    name: 'terracotta',
    light: { background: '#985644', foreground: '#FFF2E8' },
    dark: { background: '#794C40', foreground: '#FFEDE3' },
  },
  {
    name: 'teal',
    light: { background: '#3E6A68', foreground: '#EEF4E9' },
    dark: { background: '#365D5B', foreground: '#E7F4EE' },
  },
  {
    name: 'burgundy',
    light: { background: '#713F4C', foreground: '#F8ECE5' },
    dark: { background: '#663E4A', foreground: '#FBEAF0' },
  },
  {
    name: 'ochre',
    light: { background: '#C3A35D', foreground: '#302719' },
    dark: { background: '#6D5C35', foreground: '#FFF2CE' },
  },
  {
    name: 'dusty-blue',
    light: { background: '#71879B', foreground: '#08121A' },
    dark: { background: '#465D73', foreground: '#ECF2FA' },
  },
  {
    name: 'sage',
    light: { background: '#A1AF96', foreground: '#253020' },
    dark: { background: '#505F48', foreground: '#EEF4E7' },
  },
  {
    name: 'rose',
    light: { background: '#C39792', foreground: '#352322' },
    dark: { background: '#755653', foreground: '#FFF0EC' },
  },
  {
    name: 'parchment',
    light: { background: '#D6C8AD', foreground: '#383126' },
    dark: { background: '#625A4A', foreground: '#F8F0DE' },
  },
] as const

export type CoverColours = (typeof COVER_PALETTE)[number]

/**
 * The colours of one book's drawn cover, picked by its id: the same book keeps them across renders,
 * reloads and devices, and a theme switch changes only the light/dark half of the same pair. FNV-1a —
 * a tiny, stable string hash; ids that differ by a character spread across the palette.
 */
export function coverColoursFor(bookId: string): CoverColours {
  let hash = 0x811c9dc5

  for (let index = 0; index < bookId.length; index += 1) {
    hash ^= bookId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  // `>>> 0` reads the 32 bits as unsigned, so the remainder is never negative.
  return COVER_PALETTE[(hash >>> 0) % COVER_PALETTE.length] ?? COVER_PALETTE[0]
}
