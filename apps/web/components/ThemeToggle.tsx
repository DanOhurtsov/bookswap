'use client'

import { useSyncExternalStore } from 'react'
import { MoonIcon, SunIcon } from 'lucide-react'
import { applyTheme, DEFAULT_THEME, isTheme, THEME_STORAGE_KEY, type Theme } from '@/app/lib/theme'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'

const THEME_CHANGE_EVENT = 'bookswap-theme-change'

// Each entry describes the theme the toggle switches TO, not the current one.
const SWITCH_TO = {
  light: { next: 'dark', label: 'Темна тема', icon: MoonIcon },
  dark: { next: 'light', label: 'Світла тема', icon: SunIcon },
} as const satisfies Record<Theme, { next: Theme; label: string; icon: typeof SunIcon }>

function getThemeSnapshot(): Theme {
  const theme = document.documentElement.dataset.theme
  return isTheme(theme) ? theme : DEFAULT_THEME
}

function subscribeToTheme(onStoreChange: () => void): () => void {
  const handleStorageChange = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return

    applyTheme(document.documentElement, isTheme(event.newValue) ? event.newValue : DEFAULT_THEME)
    onStoreChange()
  }

  window.addEventListener('storage', handleStorageChange)
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange)

  return () => {
    window.removeEventListener('storage', handleStorageChange)
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange)
  }
}

function useThemeToggle() {
  const theme = useSyncExternalStore<Theme>(subscribeToTheme, getThemeSnapshot, () => DEFAULT_THEME)
  const { next, label, icon } = SWITCH_TO[theme]

  const toggle = () => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Theme switching still works for the current page when storage is blocked.
    }

    applyTheme(document.documentElement, next)
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT))
  }

  return { label, Icon: icon, toggle }
}

/** Profile-menu row for signed-in users. Keeps the menu open so the change is visible. */
export function ThemeToggleMenuItem() {
  const { label, Icon, toggle } = useThemeToggle()

  return (
    <DropdownMenuItem closeOnClick={false} className="justify-between" onClick={toggle}>
      {label}
      <Icon aria-hidden="true" />
    </DropdownMenuItem>
  )
}

/** Standalone button for the navbar states that have no profile menu (loading, guest). */
export function ThemeToggleButton() {
  const { label, Icon, toggle } = useThemeToggle()

  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={toggle}>
      <Icon aria-hidden="true" />
    </Button>
  )
}
