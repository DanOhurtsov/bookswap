'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { TabLink, TabLinks } from '@/components/ui/tabs'
import {
  LIBRARY_SECTIONS,
  currentLibrarySection,
  type LibrarySection,
} from '../model/library-sections'

type LibrarySectionPageProps = {
  children: ReactNode
}

/**
 * The frame every «Моя бібліотека» route shares: the page's one `h1`, the section navigation, then
 * the open section under its own `h2`. That heading is for assistive technology only: on screen the
 * current link right above the content already names the section.
 *
 * Each route keeps its own screen and its own loading; this frame only puts them under one title.
 */
export function LibrarySectionPage({ children }: LibrarySectionPageProps) {
  const section = currentLibrarySection(usePathname())

  return (
    <main className="page">
      <h1>Моя бібліотека</h1>
      <LibrarySectionNav current={section} />
      {section !== undefined && <h2 className="sr-only">{section.label}</h2>}
      {children}
    </main>
  )
}

type LibrarySectionNavProps = {
  current: LibrarySection | undefined
}

/**
 * Links between routes, not an ARIA tablist: every section is its own page with its own address.
 *
 * The rule under the row sets this level apart from the tabs inside a section (the shelves, the
 * sides of a loan), which share the same look; the active underline lands on it. On the narrowest
 * screens the row wraps rather than scrolls: Chrome does not scroll a half-hidden link into view when
 * it takes keyboard focus, so a scrolling row would hide the focused section.
 */
function LibrarySectionNav({ current }: LibrarySectionNavProps) {
  return (
    <nav aria-label="Розділи бібліотеки" className="mb-8 border-b border-(--line)">
      <TabLinks>
        {LIBRARY_SECTIONS.map((section) => (
          <TabLink key={section.href} href={section.href} current={section === current}>
            {section.label}
          </TabLink>
        ))}
      </TabLinks>
    </nav>
  )
}
