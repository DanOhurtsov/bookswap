/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { act, render, renderHook, screen } from '@testing-library/react'
import { renderToString } from 'react-dom/server'
import type { SessionState } from './use-session'
import { LoginLink, useGuestRedirect } from './use-login-redirect'

const mockReplace = jest.fn()
// A stable router object, as in Next: the guard's effect depends on it.
const mockRouter = { replace: mockReplace }

jest.mock('next/navigation', () => ({ useRouter: () => mockRouter }))

function open(address: string): void {
  window.history.replaceState(null, '', address)
}

beforeEach(() => {
  jest.clearAllMocks()
  open('/loans?tab=history&historyView=lent#loan-7')
})

describe('useGuestRedirect', () => {
  it('sends a guest to sign in with the whole address: path, query and fragment', () => {
    renderHook(() => {
      useGuestRedirect('guest')
    })

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith(
      '/login?returnTo=%2Floans%3Ftab%3Dhistory%26historyView%3Dlent%23loan-7',
    )
  })

  it.each<SessionState['status']>(['loading', 'authenticated', 'error'])(
    'does not redirect while the session is %s',
    (status) => {
      renderHook(() => {
        useGuestRedirect(status)
      })

      expect(mockReplace).not.toHaveBeenCalled()
    },
  )

  it('redirects once the check settles on guest, with the address as it is at that moment', () => {
    const { rerender } = renderHook(
      ({ status }: { status: SessionState['status'] }) => {
        useGuestRedirect(status)
      },
      { initialProps: { status: 'loading' } },
    )

    open('/works/w-1?edition=e-2#holders')
    rerender({ status: 'guest' })
    rerender({ status: 'guest' })

    expect(mockReplace).toHaveBeenCalledTimes(1)
    expect(mockReplace).toHaveBeenCalledWith(
      '/login?returnTo=%2Fworks%2Fw-1%3Fedition%3De-2%23holders',
    )
  })

  it('does not take a page of signing in as somewhere to come back to', () => {
    open('/login?returnTo=%2Flibrary')
    renderHook(() => {
      useGuestRedirect('guest')
    })

    expect(mockReplace).toHaveBeenCalledWith('/login')
  })
})

describe('LoginLink', () => {
  it('links to sign in and back to the page on screen', () => {
    render(<LoginLink className="x">Увійти</LoginLink>)

    const link = screen.getByRole('link', { name: 'Увійти' })

    expect(link).toHaveAttribute(
      'href',
      '/login?returnTo=%2Floans%3Ftab%3Dhistory%26historyView%3Dlent%23loan-7',
    )
    expect(link).toHaveClass('x')
  })

  it('follows a fragment change', () => {
    render(<LoginLink>Увійти</LoginLink>)

    act(() => {
      open('/library#own')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(screen.getByRole('link', { name: 'Увійти' })).toHaveAttribute(
      'href',
      '/login?returnTo=%2Flibrary%23own',
    )
  })

  it('renders a plain /login on the server, where there is no address bar', () => {
    expect(renderToString(<LoginLink>Увійти</LoginLink>)).toContain('href="/login"')
  })
})
