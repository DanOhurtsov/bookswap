/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RequestCopyForm } from './RequestCopyForm'

function setup(over: { busy?: boolean; submitting?: boolean } = {}) {
  const onSubmit = jest.fn()
  const onCancel = jest.fn()

  render(
    <RequestCopyForm
      copyId="c-1"
      busy={over.busy ?? false}
      submitting={over.submitting ?? false}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  )

  return { onSubmit, onCancel }
}

describe('RequestCopyForm', () => {
  it('submits an empty request as an empty body', async () => {
    const { onSubmit } = setup()

    await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

    expect(onSubmit).toHaveBeenCalledWith({})
  })

  it('submits the message and the proposed date', async () => {
    const { onSubmit } = setup()

    await userEvent.type(screen.getByLabelText('Повідомлення'), 'Привіт')
    await userEvent.type(screen.getByLabelText('Хочу повернути до'), '2027-01-15')
    await userEvent.click(screen.getByRole('button', { name: 'Надіслати запит' }))

    expect(onSubmit).toHaveBeenCalledWith({ message: 'Привіт', proposedDueAt: '2027-01-15' })
  })

  it('cancel calls back; busy disables both buttons; submitting changes the label', async () => {
    const { onCancel } = setup()

    await userEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('shows «Надсилаю…» and disables while busy', () => {
    setup({ busy: true, submitting: true })

    expect(screen.getByRole('button', { name: 'Надсилаю…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeDisabled()
  })
})
