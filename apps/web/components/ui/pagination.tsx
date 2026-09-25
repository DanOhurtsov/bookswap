import * as React from 'react'
import Link from 'next/link'
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

/**
 * shadcn `pagination` (Base UI, стиль `base-nova`), адаптований до Next.js за
 * документацією: `PaginationLink` рендерить `next/link` замість `<a>` через
 * `render` компонента `Button`. Так сторінки лишаються звичайними посиланнями —
 * адресу можна скопіювати, а «назад»/«вперед» веде браузер.
 *
 * Підписи за замовчуванням українські: ці компоненти живуть у застосунку, де
 * інтерфейс українською.
 */
function Pagination({ className, ...props }: React.ComponentProps<'nav'>) {
  return (
    <nav
      role="navigation"
      aria-label="Сторінки результатів"
      data-slot="pagination"
      className={cn('mx-auto flex w-full justify-center', className)}
      {...props}
    />
  )
}

function PaginationContent({ className, ...props }: React.ComponentProps<'ul'>) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn('flex items-center gap-0.5', className)}
      {...props}
    />
  )
}

function PaginationItem({ ...props }: React.ComponentProps<'li'>) {
  return <li data-slot="pagination-item" {...props} />
}

type PaginationLinkProps = {
  isActive?: boolean
} & Pick<React.ComponentProps<typeof Button>, 'size'> &
  React.ComponentProps<typeof Link>

function PaginationLink({ className, isActive, size = 'icon', ...props }: PaginationLinkProps) {
  return (
    <Button
      variant={isActive ? 'outline' : 'ghost'}
      size={size}
      className={cn(className)}
      nativeButton={false}
      render={
        <Link
          // Base UI's `Button` puts `role="button"` on a non-native element, which
          // would announce every page LINK as a button (and `aria-current` belongs
          // to links). The element is a link; say so.
          role="link"
          aria-current={isActive ? 'page' : undefined}
          data-slot="pagination-link"
          data-active={isActive}
          {...props}
        />
      }
    />
  )
}

function PaginationPrevious({
  className,
  text = 'Назад',
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  return (
    <PaginationLink
      aria-label="Попередня сторінка"
      size="default"
      className={cn('pl-1.5!', className)}
      {...props}
    >
      <ChevronLeftIcon data-icon="inline-start" className="cn-rtl-flip" />
      <span className="hidden sm:block">{text}</span>
    </PaginationLink>
  )
}

function PaginationNext({
  className,
  text = 'Далі',
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  return (
    <PaginationLink
      aria-label="Наступна сторінка"
      size="default"
      className={cn('pr-1.5!', className)}
      {...props}
    >
      <span className="hidden sm:block">{text}</span>
      <ChevronRightIcon data-icon="inline-end" className="cn-rtl-flip" />
    </PaginationLink>
  )
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn(
        "flex size-8 items-center justify-center [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <MoreHorizontalIcon />
      <span className="sr-only">Ще сторінки</span>
    </span>
  )
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
}
