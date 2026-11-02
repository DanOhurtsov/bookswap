import { COVER_PALETTE, coverColoursFor } from './cover-palette'

describe('coverColoursFor', () => {
  it('одна книжка — завжди ті самі кольори', () => {
    const first = coverColoursFor('work-1984')

    expect(coverColoursFor('work-1984')).toBe(first)
    expect(coverColoursFor('work-1984').name).toBe(first.name)
  })

  it('не залежить від порядку книжок і від інших книжок на полиці', () => {
    const ids = ['work-a', 'work-b', 'work-c', 'work-d']
    const forward = ids.map((id) => coverColoursFor(id).name)
    const backward = [...ids].reverse().map((id) => coverColoursFor(id).name)

    expect(backward.reverse()).toEqual(forward)
  })

  it('кольори розходяться по всій палітрі, а не збиваються в кілька', () => {
    const used = new Set(
      Array.from({ length: 200 }, (_, index) => coverColoursFor(`work-${String(index)}`).name),
    )

    expect(used.size).toBe(COVER_PALETTE.length)
  })

  it('кожна пара має і світлий, і темний варіант', () => {
    for (const colours of COVER_PALETTE) {
      expect(colours.light.background).toMatch(/^#[0-9A-F]{6}$/)
      expect(colours.dark.foreground).toMatch(/^#[0-9A-F]{6}$/)
    }
  })
})
