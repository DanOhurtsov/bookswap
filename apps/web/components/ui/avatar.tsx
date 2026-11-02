'use client'

import * as React from 'react'
import { Avatar as AvatarPrimitive } from '@base-ui/react/avatar'

import { avatarColoursFor } from '@/components/avatar-palette'
import { cn } from '@/lib/utils'

function Avatar({
  className,
  size = 'default',
  ...props
}: AvatarPrimitive.Root.Props & {
  size?: 'default' | 'sm' | 'lg'
}) {
  return (
    // The hairline ring frames a photo or the neutral grey; the canvas draws a pastel without one.
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        'group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten has-[[data-variant=pastel]]:after:hidden',
        className,
      )}
      {...props}
    />
  )
}

function AvatarImage({ className, ...props }: AvatarPrimitive.Image.Props) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn('aspect-square size-full rounded-full object-cover', className)}
      {...props}
    />
  )
}

/** The drawn colours, both themes at once: the theme class picks a pair in CSS. */
type PastelStyle = React.CSSProperties &
  Record<`--avatar-${'light' | 'dark'}-${'bg' | 'fg'}`, string>

/**
 * `neutral` (the default) is the grey of the design system. `pastel` is the canvas's colour picked by
 * the first letter of `name` (BS-147, the home page) — opted into per place, never everywhere at once.
 */
type FallbackVariant = { variant?: 'neutral' } | { variant: 'pastel'; name: string }

function AvatarFallback({
  className,
  style,
  ...props
}: AvatarPrimitive.Fallback.Props & FallbackVariant) {
  if (props.variant !== 'pastel') {
    const { variant: _neutral, ...rest } = props
    return (
      <AvatarPrimitive.Fallback
        data-slot="avatar-fallback"
        className={cn(
          'flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs',
          className,
        )}
        style={style}
        {...rest}
      />
    )
  }

  const { variant, name, ...rest } = props
  const { light, dark } = avatarColoursFor(name)
  const pastel: PastelStyle = {
    '--avatar-light-bg': light.background,
    '--avatar-light-fg': light.foreground,
    '--avatar-dark-bg': dark.background,
    '--avatar-dark-fg': dark.foreground,
  }

  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      data-variant={variant}
      className={cn(
        'flex size-full items-center justify-center rounded-full bg-(--avatar-light-bg) text-sm font-semibold text-(--avatar-light-fg) group-data-[size=sm]/avatar:text-xs dark:bg-(--avatar-dark-bg) dark:text-(--avatar-dark-fg)',
        className,
      )}
      // A caller's own style still applies, over the colours, as base-ui allows: an object or a function of state.
      style={
        typeof style === 'function'
          ? (state) => ({ ...pastel, ...style(state) })
          : { ...pastel, ...style }
      }
      {...rest}
    />
  )
}

function AvatarBadge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        'absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none',
        'group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden',
        'group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2',
        'group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2',
        className,
      )}
      {...props}
    />
  )
}

function AvatarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        'group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background',
        className,
      )}
      {...props}
    />
  )
}

function AvatarGroupCount({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        'relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3',
        className,
      )}
      {...props}
    />
  )
}

export { Avatar, AvatarImage, AvatarFallback, AvatarGroup, AvatarGroupCount, AvatarBadge }
