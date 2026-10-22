/** @jest-environment jsdom */

import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { LibrarySectionPage } from './LibrarySectionPage'

let mockPathname = '/library'

jest.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

function renderSection(pathname: string): void {
  mockPathname = pathname
  render(
    <LibrarySectionPage>
      <p>Вміст розділу</p>
    </LibrarySectionPage>,
  )
}

const sectionNav = () => screen.getByRole('navigation', { name: 'Розділи бібліотеки' })

describe('LibrarySectionPage', () => {
  it('веде на три розділи в погодженому порядку звичайними посиланнями, а не вкладками', () => {
    renderSection('/library')

    const links = within(sectionNav()).getAllByRole('link')

    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Книжки', '/library'],
      ['Позичання', '/loans'],
      ['Вішлист', '/wishlist'],
    ])
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it.each([
    ['/library', 'Книжки'],
    ['/loans', 'Позичання'],
    ['/wishlist', 'Вішлист'],
  ])('на %s поточним позначено лише «%s», і розділ має свій підзаголовок', (pathname, label) => {
    renderSection(pathname)

    const current = within(sectionNav())
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')

    expect(current.map((link) => link.textContent)).toEqual([label])
    // The underline of the line tabs hangs on `data-active`: not only the colour changes.
    expect(current[0]).toHaveAttribute('data-active')
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
      'Моя бібліотека',
    ])
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(label)
  })

  it('порядок: заголовок «Моя бібліотека», навігація, вміст розділу', () => {
    renderSection('/loans')

    const heading = screen.getByRole('heading', { level: 1 })
    const content = screen.getByText('Вміст розділу')

    expect(heading.compareDocumentPosition(sectionNav())).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(sectionNav().compareDocumentPosition(content)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('кожне посилання — окрема зупинка Tab', async () => {
    const user = userEvent.setup()

    renderSection('/wishlist')

    for (const name of ['Книжки', 'Позичання', 'Вішлист']) {
      await user.tab()
      expect(within(sectionNav()).getByRole('link', { name })).toHaveFocus()
    }
  })
})
