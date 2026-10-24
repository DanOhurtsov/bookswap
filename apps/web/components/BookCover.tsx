'use client'

import { cva } from 'class-variance-authority'
import { BookIcon } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'
import { cn } from '@/lib/utils'

type BookCoverVariant = 'inline' | 'card'

/**
 * Cover box sizes, in the one place that owns them.
 *
 * The image and the placeholder are laid out by the SAME `coverBox` variant,
 * so the box is identical whether or not there is a picture. That is the
 * point of routing both through one component: a row must not change height,
 * width or alignment because a source happened to know a cover URL.
 *
 * `inline` (the default) sits beside text: the dialog, the own-book page.
 * `card` sits on top of a vertical search card: a larger box that shows the
 * whole cover — `object-contain`, centered, never cropped — because a card
 * that crops one cover and not the next reads as inconsistent.
 */
const COVER_SIZE: Record<BookCoverVariant, { width: number; height: number }> = {
  inline: { width: 72, height: 108 },
  card: { width: 128, height: 192 },
}

const coverBox = cva('rounded-[0.25rem] bg-[color:var(--field-bg)]', {
  variants: {
    variant: {
      inline: 'h-[6.75rem] w-[4.5rem] object-cover',
      card: 'h-48 w-32 object-contain',
    },
  },
})

type BookCoverProps = {
  /**
   * The cover as its source reported it. Our catalog says `null`, the external
   * contracts say `undefined`, and both have been seen saying `''` — all three
   * mean the same thing here, so all three are accepted rather than pushed back
   * onto every caller.
   */
  url?: string | null
  /** Describes the book, e.g. `Обкладинка «Кобзар»`. */
  alt: string
  variant?: BookCoverVariant
  /**
   * Left out, the cover loads lazily — `next/image`'s default. `eager` is for a cover the caller
   * knows to be above the fold, where a lazy one is late as the Largest Contentful Paint.
   */
  loading?: 'lazy' | 'eager'
}

/**
 * A URL we can actually hand to `next/image`.
 *
 * `next/image` THROWS during render on a src it cannot parse — it does not fire
 * `onError` — and a throw inside a results list takes down the whole page. A
 * stored value that is not a usable URL is exactly the "no cover" case this
 * component exists for, so it is answered with the placeholder instead.
 */
function usableSrc(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined

  const trimmed = url.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('/')) return trimmed

  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined
  } catch {
    return undefined
  }
}

/**
 * One book cover: the picture when there is one, the same-sized placeholder
 * when there is not.
 *
 * Every cover on `/catalog` and `/catalog/new` goes through here — local rows,
 * external rows and the ISBN lookup card alike — because "no cover" has to look
 * the same everywhere or it reads as a defect rather than as an absence.
 *
 * A failure is remembered as the src that FAILED, not as a boolean. That single
 * choice covers the two requirements that pull against each other: the same
 * broken URL is never requested twice (the placeholder simply stays), while a
 * different book — or the same book after its URL is corrected — is tried
 * again, because the new src no longer matches the remembered one.
 *
 * `unoptimized` on every cover, not just the external ones: `next/image` throws
 * on a host absent from `images.remotePatterns` (`next.config.ts`), and one such
 * cover anywhere in a list would take the whole list down with it.
 *
 * The placeholder is `aria-hidden`: it carries no information the title beside
 * it does not already carry, and labelling it "cover" would announce a cover
 * that does not exist.
 */
export function BookCover({ url, alt, variant = 'inline', loading }: BookCoverProps) {
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined)
  const src = usableSrc(url)

  if (src === undefined || src === failedSrc) {
    return (
      <span
        data-slot="book-cover-placeholder"
        className={cn(
          coverBox({ variant }),
          'grid place-items-center border border-[color:var(--line)] text-[color:var(--bookswap-muted)]',
        )}
        aria-hidden="true"
      >
        <BookIcon className={cn('stroke-[1.25]', variant === 'card' ? 'size-10' : 'size-7')} />
      </span>
    )
  }

  return (
    <Image
      data-slot="book-cover"
      className={coverBox({ variant })}
      src={src}
      alt={alt}
      width={COVER_SIZE[variant].width}
      height={COVER_SIZE[variant].height}
      loading={loading}
      unoptimized
      onError={() => {
        setFailedSrc(src)
      }}
    />
  )
}
