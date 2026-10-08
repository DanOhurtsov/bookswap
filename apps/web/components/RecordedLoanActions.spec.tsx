/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Loan } from '@bookswap/shared'
import { RecordedLoanActions } from './RecordedLoanActions'

const loan = {
  id: 'loan-1',
  status: 'PENDING_CONFIRMATION',
  origin: 'RECORDED_EXISTING',
  handedAt: '2026-09-01T00:00:00.000Z',
  dueAt: '2026-10-01',
  owner: { id: 'owner', displayName: 'Марта', avatarUrl: null },
  borrower: { id: 'borrower', displayName: 'Олесь', avatarUrl: null },
} as unknown as Loan

function setup(isOwner: boolean, busy = false) {
  const onAct = jest.fn().mockResolvedValue(undefined)
  const onConfirm = jest.fn()

  render(
    <RecordedLoanActions
      loan={loan}
      isOwner={isOwner}
      busy={busy}
      busyKey={undefined}
      onAct={onAct}
      onConfirm={onConfirm}
    />,
  )

  return { onAct, onConfirm }
}

describe('RecordedLoanActions (Stage 10, 10e)', () => {
  it('позичальник бачить, що власник записав передачу, і може підтвердити або відхилити', async () => {
    const { onAct, onConfirm } = setup(false)

    expect(screen.getByText(/Власник записав, що передав вам цю книжку/)).toBeInTheDocument()
    expect(screen.getByText(/недоступна іншим/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Відкликати запис' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Коли віддали')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Підтверджую: отримав книжку' }))

    expect(onAct).toHaveBeenCalledWith(loan, 'confirm_record')

    await userEvent.click(screen.getByRole('button', { name: 'Відхилити запис' }))

    expect(onAct).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ confirmLabel: 'Відхилити запис' }),
    )
  })

  it('власник бачить очікування, попередження про недоступність, і може відкликати через підтвердження', async () => {
    const { onAct, onConfirm } = setup(true)

    expect(screen.getByText(/Чекаємо, поки Олесь підтвердить отримання/)).toBeInTheDocument()
    expect(screen.getByText(/недоступна іншим/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Підтверджую: отримав книжку' }),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Відкликати запис' }))

    expect(onAct).not.toHaveBeenCalled()

    const [confirmation] = onConfirm.mock.calls[0] as [{ run: () => Promise<void> }]

    await confirmation.run()

    expect(onAct).toHaveBeenCalledWith(loan, 'withdraw_record')
  })

  it('«Зберегти нові дати» неактивна без змін і шле лише змінене поле', async () => {
    const { onAct } = setup(true)
    const save = screen.getByRole('button', { name: 'Зберегти нові дати' })

    expect(save).toBeDisabled()

    await userEvent.clear(screen.getByLabelText('Повернути до'))
    await userEvent.type(screen.getByLabelText('Повернути до'), '2026-10-15')

    expect(save).toBeEnabled()

    await userEvent.click(save)

    expect(onAct).toHaveBeenCalledWith(loan, 'amend_record', { dueAt: '2026-10-15' })
  })

  it('Q23: очищення поля строку надсилає dueAt: null; незмінена дата передачі не надсилається', async () => {
    const { onAct } = setup(true)

    await userEvent.clear(screen.getByLabelText('Повернути до'))
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти нові дати' }))

    expect(onAct).toHaveBeenCalledWith(loan, 'amend_record', { dueAt: null })
    expect(screen.queryByText(/але не прибрати/)).not.toBeInTheDocument()
  })

  it('Q23: якщо строку не було, порожнє поле нічого не надсилає (кнопка неактивна); додати строк можна', async () => {
    const onAct = jest.fn().mockResolvedValue(undefined)
    const noDue = { ...loan, dueAt: null } as Loan

    render(
      <RecordedLoanActions
        loan={noDue}
        isOwner
        busy={false}
        busyKey={undefined}
        onAct={onAct}
        onConfirm={jest.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Зберегти нові дати' })).toBeDisabled()

    await userEvent.type(screen.getByLabelText('Повернути до'), '2026-10-20')
    await userEvent.click(screen.getByRole('button', { name: 'Зберегти нові дати' }))

    expect(onAct).toHaveBeenCalledWith(noDue, 'amend_record', { dueAt: '2026-10-20' })
  })

  it('строк раніше дати передачі блокує збереження; дата передачі має max = сьогодні', async () => {
    setup(true)

    await userEvent.clear(screen.getByLabelText('Повернути до'))
    await userEvent.type(screen.getByLabelText('Повернути до'), '2026-08-01')

    expect(screen.getByRole('button', { name: 'Зберегти нові дати' })).toBeDisabled()
    expect(screen.getByLabelText('Коли віддали')).toHaveAttribute(
      'max',
      new Date().toISOString().slice(0, 10),
    )
  })

  it('поки виконується інша дія, кнопки неактивні', () => {
    setup(false, true)

    expect(screen.getByRole('button', { name: 'Підтверджую: отримав книжку' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Відхилити запис' })).toBeDisabled()
  })
})
