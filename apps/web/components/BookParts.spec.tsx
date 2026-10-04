/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { Edition } from '@bookswap/shared'
import { EditionLine } from './BookParts'

const base: Edition = {
  id: 'e-1',
  workId: 'w-1',
  translationId: null,
  textKind: 'UNKNOWN',
  publisher: null,
  year: null,
  isbn13: null,
  pageCount: null,
  coverUrl: null,
  format: null,
  lang: null,
  translator: null,
  revision: 1,
}

describe('EditionLine — невідомі дані не вигадуються', () => {
  it('без мови, формату й видавничих даних рядок порожній, а не «мʼяка · en»', () => {
    const { container } = render(<EditionLine edition={base} />)

    expect(container.textContent).toBe('')
    expect(screen.queryByText(/мʼяка|тверда|кишенькова/)).not.toBeInTheDocument()
  })

  it('показує лише те, що відомо', () => {
    render(
      <EditionLine edition={{ ...base, lang: 'uk', publisher: 'КСД', isbn13: '9786171262737' }} />,
    )

    expect(screen.getByText(/КСД · uk/)).toBeInTheDocument()
    expect(screen.getByText(/ISBN 9786171262737/)).toBeInTheDocument()
  })
})
