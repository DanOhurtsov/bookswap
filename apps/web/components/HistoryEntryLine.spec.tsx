/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import type { HistoryEntry } from '@bookswap/shared'
import { HistoryEntryLine } from './HistoryEntryLine'

const base = {
  status: 'RETURNED',
  isOverdue: false,
  respondedAt: null,
  handedAt: '2026-03-03T10:00:00.000Z',
  returnedAt: '2026-03-10T10:00:00.000Z',
  dueAt: null,
  names: false,
} as const

function renderEntry(entry: Partial<HistoryEntry> & Pick<HistoryEntry, 'origin' | 'requestedAt'>) {
  render(
    <ul>
      <HistoryEntryLine entry={{ ...base, ...entry } as HistoryEntry} />
    </ul>,
  )
}

describe('HistoryEntryLine (H5)', () => {
  it('звичайний request-flow (origin = REQUESTED) друкує «Попросили» і не друкує «Записано власником»', () => {
    renderEntry({ origin: 'REQUESTED', requestedAt: '2026-03-01T10:00:00.000Z' })

    expect(screen.getByText(/Попросили/)).toBeInTheDocument()
    expect(screen.queryByText(/Записано власником/)).not.toBeInTheDocument()
    expect(screen.getByText(/передали/)).toBeInTheDocument()
    expect(screen.getByText(/повернули/)).toBeInTheDocument()
  })

  it.each(['RECORDED_EXISTING', 'RECORDED_GUEST'] as const)(
    'записана власником позика (%s) з requestedAt = null показує «Записано власником» без «Попросили»',
    (origin) => {
      renderEntry({ origin, requestedAt: null })

      expect(screen.getByText(/Записано власником/)).toBeInTheDocument()
      expect(screen.queryByText(/Попросили/)).not.toBeInTheDocument()
      expect(screen.getByText(/передали/)).toBeInTheDocument()
    },
  )

  it('записана власником позика з ненульовим requestedAt (дефолт БД) теж без «Попросили»', () => {
    renderEntry({ origin: 'RECORDED_EXISTING', requestedAt: '2026-03-03T10:00:00.000Z' })

    expect(screen.getByText(/Записано власником/)).toBeInTheDocument()
    expect(screen.queryByText(/Попросили/)).not.toBeInTheDocument()
  })
})
