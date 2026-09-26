/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan } from '@bookswap/shared'
import { LostLoanRecovery } from './LostLoanRecovery'

function lostLoan(over: {
  copyStatus?: Loan['copy']['status']
  isArchived?: boolean
  recovery?: Loan['recovery']
}): Loan {
  return {
    id: 'loan-1',
    status: 'LOST',
    copy: {
      id: 'copy-1',
      status: over.copyStatus ?? 'UNAVAILABLE',
      condition: 'GOOD',
      isArchived: over.isArchived ?? false,
    },
    recovery: over.recovery ?? null,
  } as Loan
}

function setup(loan: Loan, isOwner = true, busy = false, submitting = false) {
  const onRecover = jest.fn()

  render(
    <LostLoanRecovery
      loan={loan}
      isOwner={isOwner}
      busy={busy}
      submitting={submitting}
      onRecover={onRecover}
    />,
  )

  return { onRecover }
}

describe('LostLoanRecovery', () => {
  it('власнику придатної LOST-позики пропонує «Знайшлася»; без дати — порожнє тіло', async () => {
    const { onRecover } = setup(lostLoan({}))

    await userEvent.click(screen.getByRole('button', { name: 'Знайшлася' }))

    expect(onRecover).toHaveBeenCalledWith({})
  })

  it('передає вказану дату знахідки; поле не дозволяє майбутнє', async () => {
    const { onRecover } = setup(lostLoan({}))
    const input = screen.getByLabelText('Дата знахідки')

    expect(input).toHaveAttribute('max', new Date().toISOString().slice(0, 10))

    await userEvent.type(input, '2026-09-20')
    await userEvent.click(screen.getByRole('button', { name: 'Знайшлася' }))

    expect(onRecover).toHaveBeenCalledWith({ effectiveAt: '2026-09-20' })
  })

  it('позичальник дії не бачить', () => {
    setup(lostLoan({}), false)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('архівний примірник: замість кнопки — підказка спершу відновити з архіву', () => {
    setup(lostLoan({ isArchived: true }))

    expect(screen.queryByRole('button', { name: 'Знайшлася' })).not.toBeInTheDocument()
    expect(screen.getByText(/спершу відновіть його з архіву/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'бібліотеці' })).toHaveAttribute('href', '/library')
  })

  it('примірник уже не UNAVAILABLE — кнопки немає (остаточно вирішує API)', () => {
    setup(lostLoan({ copyStatus: 'AVAILABLE' }))

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('після знахідки показує факт для обох сторін; форми немає, позика лишається «втраченою»', () => {
    const recovery = {
      effectiveAt: '2026-09-20T00:00:00.000Z',
      recordedAt: '2026-09-26T09:00:00.000Z',
    }

    for (const isOwner of [true, false]) {
      const { unmount } = render(
        <LostLoanRecovery
          loan={lostLoan({ copyStatus: 'AVAILABLE', recovery })}
          isOwner={isOwner}
          busy={false}
          submitting={false}
          onRecover={jest.fn()}
        />,
      )

      expect(screen.getByText(/Знайшлася 20 вересня 2026/)).toBeInTheDocument()
      expect(screen.getByText(/лишається позначеною як втрачена/)).toBeInTheDocument()
      expect(screen.queryByRole('button')).not.toBeInTheDocument()

      unmount()
    }
  })

  it('busy блокує кнопку; submitting міняє підпис', () => {
    setup(lostLoan({}), true, true, true)

    expect(screen.getByRole('button', { name: 'Виконую…' })).toBeDisabled()
  })
})
