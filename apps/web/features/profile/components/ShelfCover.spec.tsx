/** @jest-environment jsdom */

import { fireEvent, render } from '@testing-library/react'
import '@testing-library/jest-dom'
import { coverColoursFor } from '../model/cover-palette'
import { ShelfCover } from './ShelfCover'

const COVER = 'https://covers.openlibrary.org/b/id/42-M.jpg'
const OTHER_COVER = 'https://covers.openlibrary.org/b/id/43-M.jpg'

/** Both kinds are `aria-hidden` (the link around them names the book), so the tests find them by slot. */
function drawn(container: HTMLElement): HTMLElement | null {
  return container.querySelector("[data-slot='drawn-cover']")
}

function picture(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('img')
}

const BOOK = { bookId: 'work-42', title: 'Тигролови', authors: 'Іван Багряний' }

describe('ShelfCover', () => {
  it('shows the picture when there is one, decorative', () => {
    const { container } = render(<ShelfCover {...BOOK} url={COVER} />)

    expect(picture(container)).toHaveAttribute('src', COVER)
    expect(picture(container)).toHaveAttribute('alt', '')
    expect(drawn(container)).toBeNull()
  })

  it('draws the cover in the book’s own colours when there is no picture', () => {
    const { container } = render(<ShelfCover {...BOOK} url={null} />)

    const cover = drawn(container)
    const { light, dark } = coverColoursFor(BOOK.bookId)
    expect(cover).toHaveTextContent('Тигролови')
    expect(cover).toHaveTextContent('Іван Багряний')
    expect(cover).toHaveAttribute('aria-hidden', 'true')
    expect(cover?.style.getPropertyValue('--cover-light-bg')).toBe(light.background)
    expect(cover?.style.getPropertyValue('--cover-light-fg')).toBe(light.foreground)
    expect(cover?.style.getPropertyValue('--cover-dark-bg')).toBe(dark.background)
    expect(cover?.style.getPropertyValue('--cover-dark-fg')).toBe(dark.foreground)
    expect(picture(container)).toBeNull()
  })

  it('draws the cover once the picture fails to load, and keeps it', () => {
    const { container, rerender } = render(<ShelfCover {...BOOK} url={COVER} />)

    const image = picture(container)
    expect(image).not.toBeNull()
    if (image !== null) fireEvent.error(image)

    expect(drawn(container)).toHaveTextContent('Тигролови')
    expect(picture(container)).toBeNull()

    // The same broken URL on the next render is not asked for again…
    rerender(<ShelfCover {...BOOK} url={COVER} />)
    expect(picture(container)).toBeNull()

    // …a corrected one is.
    rerender(<ShelfCover {...BOOK} url={OTHER_COVER} />)
    expect(picture(container)).toHaveAttribute('src', OTHER_COVER)
  })

  it('leaves the foot of the cover empty when the book has no author', () => {
    const { container } = render(<ShelfCover {...BOOK} url={null} authors="" />)

    expect(container.querySelector('.profile-cover__author')).toBeNull()
    expect(drawn(container)).toHaveTextContent('Тигролови')
  })

  it('is the same colour for the same book in any render', () => {
    const first = render(<ShelfCover {...BOOK} url={null} />)
    const style = drawn(first.container)?.getAttribute('style')
    first.unmount()

    const second = render(<ShelfCover {...BOOK} title="Інша назва" url={null} />)
    expect(drawn(second.container)?.getAttribute('style')).toBe(style)
  })
})
