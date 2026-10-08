export const THEME_STORAGE_KEY = 'bookswap-theme'

export const THEMES = ['light', 'dark'] as const

export type Theme = (typeof THEMES)[number]

export const DEFAULT_THEME: Theme = 'light'

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES.includes(value as Theme)
}

export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle('dark', theme === 'dark')
  root.classList.toggle('light', theme === 'light')
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/**
 * Runs in the document head before React hydrates, preventing the saved dark
 * theme from briefly rendering as light.
 */
export const THEME_INITIALIZER_SCRIPT = `
  (() => {
    try {
      const storedTheme = localStorage.getItem('${THEME_STORAGE_KEY}');
      const theme = ${JSON.stringify(THEMES)}.includes(storedTheme)
        ? storedTheme
        : '${DEFAULT_THEME}';
      const root = document.documentElement;

      root.classList.toggle('dark', theme === 'dark');
      root.classList.toggle('light', theme === 'light');
      root.dataset.theme = theme;
      root.style.colorScheme = theme;
    } catch {
      document.documentElement.classList.add('${DEFAULT_THEME}');
    }
  })();
`
