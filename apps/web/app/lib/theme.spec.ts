/** @jest-environment jsdom */

import { applyTheme, isTheme, THEME_INITIALIZER_SCRIPT } from './theme'

describe('theme', () => {
  it('accepts only supported theme values', () => {
    expect(isTheme('light')).toBe(true)
    expect(isTheme('dark')).toBe(true)
    expect(isTheme('system')).toBe(false)
    expect(isTheme('sepia')).toBe(false)
    expect(isTheme(null)).toBe(false)
  })

  it('applies the theme class, theme metadata, and color scheme', () => {
    const root = document.documentElement

    applyTheme(root, 'dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')

    applyTheme(root, 'light')
    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.dataset.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
  })

  it.each([
    ['dark', 'dark'],
    ['light', 'light'],
    ['system', 'light'],
    [null, 'light'],
  ])('initializer maps stored %s to %s', (stored, expected) => {
    if (stored === null) window.localStorage.removeItem('bookswap-theme')
    else window.localStorage.setItem('bookswap-theme', stored)

    new Function(THEME_INITIALIZER_SCRIPT)()

    expect(document.documentElement.dataset.theme).toBe(expected)
    window.localStorage.removeItem('bookswap-theme')
  })
})
