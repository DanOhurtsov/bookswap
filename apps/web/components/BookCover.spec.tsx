/** @jest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BookCover } from './BookCover'

const ALT = 'Обкладинка «Кобзар»'
const COVER = 'https://covers.openlibrary.org/b/id/42-M.jpg'
const OTHER_COVER = 'https://covers.openlibrary.org/b/id/43-M.jpg'

/**
 * The placeholder is `aria-hidden`, so it has no accessible name to query by —
 * that is deliberate (it announces nothing a screen reader does not already get
 * from the title). Its class is what both the layout and these tests rely on.
 */
function placeholder(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.lookup-card__cover--empty')
}

describe('BookCover', () => {
  it('shows the picture when the source gave a usable URL', () => {
    const { container } = render(<BookCover url={COVER} alt={ALT} />)

    const image = screen.getByAltText(ALT)
    expect(image).toHaveClass('lookup-card__cover')
    // `unoptimized`, so the URL reaches the browser exactly as the source gave it.
    expect(image).toHaveAttribute('src', COVER)
    expect(placeholder(container)).toBeNull()
  })

  it.each([
    ['missing', undefined],
    ['null, as our own catalog reports it', null],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('shows the placeholder when the cover is %s', (_case, url) => {
    const { container } = render(<BookCover url={url} alt={ALT} />)

    expect(placeholder(container)).not.toBeNull()
    expect(screen.queryByAltText(ALT)).toBeNull()
  })

  /**
   * `next/image` THROWS on a src it cannot parse instead of firing `onError`,
   * and one such value in a results list would take the whole list down. The
   * placeholder is the same answer as for an absent cover.
   */
  it.each([
    ['is not a URL at all', 'не посилання'],
    ['is relative', 'covers/42.jpg'],
    ['uses a protocol we do not serve', 'javascript:alert(1)'],
  ])('shows the placeholder when the stored value %s', (_case, url) => {
    const { container } = render(<BookCover url={url} alt={ALT} />)

    expect(placeholder(container)).not.toBeNull()
    expect(screen.queryByAltText(ALT)).toBeNull()
  })

  it('falls back to the placeholder when the image fails to load', () => {
    const { container } = render(<BookCover url={COVER} alt={ALT} />)

    fireEvent.error(screen.getByAltText(ALT))

    expect(placeholder(container)).not.toBeNull()
    expect(screen.queryByAltText(ALT)).toBeNull()
  })

  it('keeps the same box whether it shows a picture or the placeholder', () => {
    const { container } = render(<BookCover url={COVER} alt={ALT} />)
    fireEvent.error(screen.getByAltText(ALT))

    // Same class, therefore same width, height and corner radius: a row must
    // not resize because a cover failed.
    expect(placeholder(container)).toHaveClass('lookup-card__cover')
  })

  it('does not ask for a failed URL again', () => {
    render(<BookCover url={COVER} alt={ALT} />)
    const image = screen.getByAltText(ALT)

    fireEvent.error(image)
    fireEvent.error(image)

    expect(screen.queryByAltText(ALT)).toBeNull()
  })

  it('tries again when the book changes after a failure', () => {
    const { container, rerender } = render(<BookCover url={COVER} alt={ALT} />)
    fireEvent.error(screen.getByAltText(ALT))

    rerender(<BookCover url={OTHER_COVER} alt="Обкладинка «Лісова пісня»" />)

    const image = screen.getByAltText('Обкладинка «Лісова пісня»')
    expect(image).toHaveAttribute('src', OTHER_COVER)
    expect(placeholder(container)).toBeNull()
  })

  it('tries again when a failed cover URL is corrected in place', () => {
    const { container, rerender } = render(<BookCover url={COVER} alt={ALT} />)
    fireEvent.error(screen.getByAltText(ALT))

    rerender(<BookCover url={OTHER_COVER} alt={ALT} />)

    expect(screen.getByAltText(ALT)).toHaveAttribute('src', OTHER_COVER)
    expect(placeholder(container)).toBeNull()
  })

  it('falls back again when the new cover also fails', () => {
    const { container, rerender } = render(<BookCover url={COVER} alt={ALT} />)
    fireEvent.error(screen.getByAltText(ALT))

    rerender(<BookCover url={OTHER_COVER} alt={ALT} />)
    fireEvent.error(screen.getByAltText(ALT))

    expect(placeholder(container)).not.toBeNull()
    expect(screen.queryByAltText(ALT)).toBeNull()
  })
})
