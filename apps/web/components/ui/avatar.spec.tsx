/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { avatarColoursFor } from '@/components/avatar-palette'
import { Avatar, AvatarFallback } from './avatar'

describe('AvatarFallback', () => {
  it('за замовчуванням — нейтральний сірий, як і досі', () => {
    render(
      <Avatar>
        <AvatarFallback>ІП</AvatarFallback>
      </Avatar>,
    )

    const fallback = screen.getByText('ІП')
    expect(fallback).toHaveClass('bg-muted', 'text-muted-foreground')
    expect(fallback).not.toHaveAttribute('data-variant')
    expect(fallback.getAttribute('style') ?? '').not.toContain('--avatar-')
  })

  it('pastel — кольори за першою літерою імені для обох тем', () => {
    render(
      <Avatar>
        <AvatarFallback variant="pastel" name="Ірина Петренко">
          ІП
        </AvatarFallback>
      </Avatar>,
    )

    const fallback = screen.getByText('ІП')
    const { light, dark } = avatarColoursFor('Ірина')
    expect(fallback).toHaveAttribute('data-variant', 'pastel')
    expect(fallback).not.toHaveClass('bg-muted')
    expect(fallback.style.getPropertyValue('--avatar-light-bg')).toBe(light.background)
    expect(fallback.style.getPropertyValue('--avatar-light-fg')).toBe(light.foreground)
    expect(fallback.style.getPropertyValue('--avatar-dark-bg')).toBe(dark.background)
    expect(fallback.style.getPropertyValue('--avatar-dark-fg')).toBe(dark.foreground)
  })

  it('pastel не відкидає власний style того, хто його рендерить', () => {
    render(
      <Avatar>
        <AvatarFallback variant="pastel" name="Тарас" style={{ fontSize: '10px' }}>
          Т
        </AvatarFallback>
      </Avatar>,
    )

    const fallback = screen.getByText('Т')
    expect(fallback.style.fontSize).toBe('10px')
    expect(fallback.style.getPropertyValue('--avatar-light-bg')).toBe(
      avatarColoursFor('Тарас').light.background,
    )
  })
})
