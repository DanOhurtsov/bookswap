/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ThemeToggleButton } from './ThemeToggle'

describe('ThemeToggleButton', () => {
  beforeEach(() => {
    window.localStorage.clear()
    delete document.documentElement.dataset.theme
  })

  it('shows the icon of the theme it will switch to and flips on click', async () => {
    document.documentElement.dataset.theme = 'light'
    render(<ThemeToggleButton />)

    const toggle = screen.getByRole('button', { name: 'Темна тема' })
    await userEvent.click(toggle)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement).toHaveClass('dark')
    expect(window.localStorage.getItem('bookswap-theme')).toBe('dark')
    expect(screen.getByRole('button', { name: 'Світла тема' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Світла тема' }))

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(screen.getByRole('button', { name: 'Темна тема' })).toBeInTheDocument()
  })

  it('treats a legacy "system" value as the default light theme', () => {
    document.documentElement.dataset.theme = 'system'
    render(<ThemeToggleButton />)

    expect(screen.getByRole('button', { name: 'Темна тема' })).toBeInTheDocument()
  })
})
