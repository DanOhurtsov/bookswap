/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GuestLoan } from '@bookswap/shared'
import { GuestLoanActions } from './GuestLoanActions'

const BASE_LOAN: GuestLoan = {
  id: 'loan-1',
  status: 'HANDED_OVER',
  isOverdue: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  handedAt: '2026-01-01T00:00:00.000Z',
  returnedAt: null,
  dueAt: null,
  copy: { id: 'copy-1', status: 'LENT_OUT', condition: 'GOOD', isArchived: false },
  edition: {
    id: 'ed-1',
    workId: 'work-1',
    translationId: null,
    publisher: null,
    year: null,
    isbn13: null,
    pageCount: null,
    coverUrl: null,
    format: 'PAPERBACK',
    lang: 'uk',
    translator: null,
    revision: 1,
  },
  work: {
    id: 'work-1',
    title: 'Тестова книга',
    origLang: 'uk',
    firstPubYear: null,
    description: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    revision: 1,
  },
  authors: [],
  contact: { id: 'contact-1', alias: 'Гість' },
  recovery: null,
  lossClosure: null,
}

function loan(overrides: Partial<GuestLoan>): GuestLoan {
  return { ...BASE_LOAN, ...overrides }
}

/** jsdom has no `showModal`; the mark_lost confirmation is a native `<dialog>`. */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
})

describe('GuestLoanActions (Stage 10, 10f.3)', () => {
  it('HANDED_OVER: «Повернуто» діє відразу, «Втрачено» — лише після підтвердження', async () => {
    const onAct = jest.fn().mockResolvedValue(undefined)
    render(
      <GuestLoanActions
        loan={loan({ status: 'HANDED_OVER' })}
        busy={false}
        busyKey={undefined}
        onAct={onAct}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Повернуто' }))
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'loan-1' }), 'return')

    await userEvent.click(screen.getByRole('button', { name: 'Втрачено' }))
    expect(onAct).not.toHaveBeenCalledWith(expect.anything(), 'mark_lost')

    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByText('Позначити втраченою?')).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Втрачено' }))
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'loan-1' }), 'mark_lost')
  })

  it('RETURNED: жодних дій', () => {
    render(
      <GuestLoanActions
        loan={loan({ status: 'RETURNED', returnedAt: '2026-02-01T00:00:00.000Z' })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('LOST без recovery/lossClosure: обидві дії доступні', () => {
    render(
      <GuestLoanActions
        loan={loan({ status: 'LOST', recovery: null, lossClosure: null })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Знайшлася' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Закрити втрату' })).toBeInTheDocument()
  })

  it('LOST з recovery: повідомлення й жодних дій (успіх не пропонується повторно)', () => {
    render(
      <GuestLoanActions
        loan={loan({
          status: 'LOST',
          recovery: {
            effectiveAt: '2026-03-01T00:00:00.000Z',
            recordedAt: '2026-03-02T00:00:00.000Z',
          },
          lossClosure: null,
        })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByText(/Знайшлася/)).toBeInTheDocument()
    expect(screen.getByText(/Позика лишається позначеною як/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Знайшлася' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Закрити втрату' })).not.toBeInTheDocument()
  })

  it('LOST з lossClosure, без recovery: «Знайшлася» лишається (Q3c), «Закрити втрату» зникає', () => {
    render(
      <GuestLoanActions
        loan={loan({
          status: 'LOST',
          recovery: null,
          lossClosure: { recordedAt: '2026-03-05T00:00:00.000Z' },
        })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByText(/Втрату закрито/)).toBeInTheDocument()
    expect(screen.getByText(/не позначено знайденою/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Знайшлася' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Закрити втрату' })).not.toBeInTheDocument()
  })

  it('LOST з recovery і lossClosure: обидва повідомлення, без кнопок, без застереження', () => {
    render(
      <GuestLoanActions
        loan={loan({
          status: 'LOST',
          recovery: {
            effectiveAt: '2026-03-01T00:00:00.000Z',
            recordedAt: '2026-03-02T00:00:00.000Z',
          },
          lossClosure: { recordedAt: '2026-03-05T00:00:00.000Z' },
        })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByText(/Знайшлася/)).toBeInTheDocument()
    expect(screen.getByText(/Втрату закрито/)).toBeInTheDocument()
    expect(screen.queryByText(/не позначено знайденою/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('LOST, архівний примірник: підказка про відновлення замість кнопки «Знайшлася», «Закрити втрату» лишається', () => {
    render(
      <GuestLoanActions
        loan={loan({
          status: 'LOST',
          recovery: null,
          lossClosure: null,
          copy: { ...BASE_LOAN.copy, isArchived: true },
        })}
        busy={false}
        busyKey={undefined}
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByText(/спершу відновіть його з архіву/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'бібліотеці' })).toHaveAttribute('href', '/library')
    expect(screen.queryByRole('button', { name: 'Знайшлася' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Закрити втрату' })).toBeInTheDocument()
  })

  it('close_loss: до підтвердження й після скасування onAct не викликається', async () => {
    const onAct = jest.fn().mockResolvedValue(undefined)
    render(
      <GuestLoanActions
        loan={loan({ status: 'LOST', recovery: null, lossClosure: null })}
        busy={false}
        busyKey={undefined}
        onAct={onAct}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Закрити втрату' }))
    expect(onAct).not.toHaveBeenCalled()

    const dialog = await screen.findByRole('alertdialog')

    expect(within(dialog).getByText('Закрити втрату?')).toBeInTheDocument()
    expect(within(dialog).getByText(/НЕ означає, що книжка знайшлася/)).toBeInTheDocument()
    expect(within(dialog).getByText(/не змінює стан примірника/)).toBeInTheDocument()

    await userEvent.click(within(dialog).getByRole('button', { name: 'Скасувати' }))
    expect(onAct).not.toHaveBeenCalled()
  })

  it('close_loss: після підтвердження onAct викликається рівно один раз із close_loss', async () => {
    const onAct = jest.fn().mockResolvedValue(undefined)
    render(
      <GuestLoanActions
        loan={loan({ status: 'LOST', recovery: null, lossClosure: null })}
        busy={false}
        busyKey={undefined}
        onAct={onAct}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Закрити втрату' }))
    const dialog = await screen.findByRole('alertdialog')

    await userEvent.click(within(dialog).getByRole('button', { name: 'Закрити втрату' }))

    expect(onAct).toHaveBeenCalledTimes(1)
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'loan-1' }), 'close_loss')
  })

  it('close_loss: під час запиту (busy) кнопка вимкнена — повторне підтвердження недоступне', () => {
    render(
      <GuestLoanActions
        loan={loan({ status: 'LOST', recovery: null, lossClosure: null })}
        busy
        busyKey="close_loss:loan-1"
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Виконую…' })).toBeDisabled()
  })

  it('recover: без введеної дати надсилає порожнє тіло (сервер запише «сьогодні»)', async () => {
    const onAct = jest.fn().mockResolvedValue(undefined)
    render(
      <GuestLoanActions
        loan={loan({ status: 'LOST', recovery: null, lossClosure: null })}
        busy={false}
        busyKey={undefined}
        onAct={onAct}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Знайшлася' }))
    expect(onAct).toHaveBeenCalledWith(expect.objectContaining({ id: 'loan-1' }), 'recover', {})
  })

  it('busyKey: кнопка у процесі показує «Виконую…»', () => {
    render(
      <GuestLoanActions
        loan={loan({ status: 'HANDED_OVER' })}
        busy
        busyKey="return:loan-1"
        onAct={jest.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Виконую…' })).toBeInTheDocument()
  })
})
