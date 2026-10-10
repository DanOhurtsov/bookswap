'use client'

import Link from 'next/link'
import { MenuIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

type NavBarMenuProps = {
  links: ReadonlyArray<{ href: string; label: string }>
  className?: string
}

/**
 * The same links as the inline navigation, folded behind one button where the inline row would
 * not fit. Which of the two is visible is decided by CSS breakpoints at the call site, so both
 * always receive the same list.
 */
export const NavBarMenu = ({ links, className }: NavBarMenuProps) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <Button
          variant="ghost"
          size="icon"
          className={className}
          aria-label="Відкрити меню навігації"
        >
          <MenuIcon aria-hidden="true" />
        </Button>
      }
    />
    <DropdownMenuContent className="w-48">
      <DropdownMenuGroup>
        {links.map((link) => (
          <DropdownMenuItem key={link.href} render={<Link href={link.href} />}>
            {link.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
)
