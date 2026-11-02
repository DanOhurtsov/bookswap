'use client'

import Image from 'next/image'
import { useState, type CSSProperties } from 'react'
import { usableSrc } from '@/components/BookCover'
import { coverColoursFor } from './cover-palette'

/** The drawn cover's colours, both themes at once: the theme class picks a pair in CSS. */
type CoverStyle = CSSProperties & Record<`--cover-${'light' | 'dark'}-${'bg' | 'fg'}`, string>

/**
 * A book on a shelf drawn from the canvas (the profile, the home page): its picture, or — when there is
 * none or it does not load — a cover drawn from the title and the author in the book's own colours.
 * Decorative either way: the link around it already says the title, the authors and where the copy is.
 *
 * As `BookCover`, a failure is remembered as the src that failed, so a broken picture is not asked for
 * again, while a corrected URL is.
 */
export function ShelfCover({
  bookId,
  url,
  title,
  authors,
}: {
  /** Picks the colours: the same book is the same colour wherever and whenever it is drawn. */
  bookId: string
  url: string | null
  title: string
  authors: string
}) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined)
  const src = usableSrc(url)

  if (src === undefined || src === failedSrc) {
    const { light, dark } = coverColoursFor(bookId)
    const style: CoverStyle = {
      '--cover-light-bg': light.background,
      '--cover-light-fg': light.foreground,
      '--cover-dark-bg': dark.background,
      '--cover-dark-fg': dark.foreground,
    }

    return (
      <span
        aria-hidden="true"
        data-slot="drawn-cover"
        className="shelf-cover shelf-cover--drawn"
        style={style}
      >
        <span className="shelf-cover__title">{title}</span>
        {/* No author — the foot of the cover stays empty rather than saying «невідомо». */}
        {authors !== '' && <span className="shelf-cover__author">{authors}</span>}
      </span>
    )
  }

  return (
    <span aria-hidden="true" className="shelf-cover">
      {/* `unoptimized` for the reason `BookCover` gives: a host outside `remotePatterns` throws. */}
      <Image
        src={src}
        alt=""
        width={160}
        height={240}
        unoptimized
        onError={() => {
          setFailedSrc(src)
        }}
      />
    </span>
  )
}
