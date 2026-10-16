/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { zodResolver } from '@hookform/resolvers/zod'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { SelectField } from './FormFields'
import { chooseOption } from './test-choose-option'

// jsdom has no `PointerEvent`; Base UI builds one to pick a select item from the keyboard.
window.PointerEvent ??= class PointerEvent extends MouseEvent {} as typeof window.PointerEvent

const CONDITIONS = [
  { value: 'NEW', label: 'Нова' },
  { value: 'WORN', label: 'Потерта' },
] as const

const trigger = (name = 'Стан') => screen.getByRole('combobox', { name })

describe('SelectField (BS-92)', () => {
  it('підпис, підказка й помилка звʼязані з полем; помилка — aria-invalid', () => {
    render(
      <SelectField
        id="condition"
        label="Стан"
        hint="Як виглядає книжка."
        error="Оберіть стан."
        value="NEW"
        options={CONDITIONS}
        onValueChange={() => undefined}
      />,
    )

    expect(trigger()).toHaveAccessibleDescription('Як виглядає книжка. Оберіть стан.')
    expect(trigger()).toHaveAttribute('aria-invalid', 'true')
    expect(trigger()).toHaveTextContent('Нова')
  })

  it('нічого не вибрано — показується підказка, а порожнього варіанта в списку немає', async () => {
    const user = userEvent.setup()

    render(
      <SelectField
        id="condition"
        label="Стан"
        value=""
        placeholder="— оберіть стан —"
        options={CONDITIONS}
        onValueChange={() => undefined}
      />,
    )

    expect(trigger()).toHaveTextContent('— оберіть стан —')
    expect(trigger()).not.toHaveAttribute('aria-invalid')
    await user.click(trigger())
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Нова',
      'Потерта',
    ])
  })

  it('disabled: список не відкривається', async () => {
    const user = userEvent.setup()

    render(
      <SelectField
        id="condition"
        label="Стан"
        value="NEW"
        options={CONDITIONS}
        disabled
        onValueChange={() => undefined}
      />,
    )

    expect(trigger()).toBeDisabled()
    await user.click(trigger())
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('клавіатура: Enter відкриває, стрілка й Enter вибирають; Escape закриває без зміни', async () => {
    const user = userEvent.setup()
    const onValueChange = jest.fn()

    render(
      <SelectField
        id="condition"
        label="Стан"
        value="NEW"
        options={CONDITIONS}
        onValueChange={onValueChange}
      />,
    )
    await user.tab()
    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull()
    })
    expect(trigger()).toHaveFocus()
    expect(onValueChange).not.toHaveBeenCalled()

    await user.keyboard('{Enter}')
    await screen.findByRole('listbox')
    await user.keyboard('{ArrowDown}{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('WORN')
    expect(trigger()).toHaveFocus()
  })
})

// `''` is the field's «nothing chosen» and fails the schema, like the app's required choices.
const schema = z.object({
  condition: z.enum(['', 'NEW', 'WORN']).refine((value) => value !== '', 'Оберіть стан.'),
})

type Values = z.input<typeof schema>

function RhfForm({
  defaults,
  onSubmit,
}: {
  defaults: Values
  onSubmit: (values: z.output<typeof schema>) => void
}) {
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, dirtyFields, touchedFields },
  } = useForm<Values, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  })

  return (
    <form onSubmit={(event) => void handleSubmit(onSubmit)(event)} noValidate>
      <Controller
        control={control}
        name="condition"
        render={({ field }) => (
          <SelectField
            id="condition"
            label="Стан"
            placeholder="— оберіть стан —"
            error={errors.condition?.message}
            value={field.value}
            options={CONDITIONS}
            onValueChange={field.onChange}
            onBlur={field.onBlur}
            inputRef={field.ref}
          />
        )}
      />
      <output aria-label="dirty">{String(dirtyFields.condition === true)}</output>
      <output aria-label="touched">{String(touchedFields.condition === true)}</output>
      <button type="button" onClick={() => reset({ condition: 'NEW' })}>
        reset
      </button>
      <button type="submit">Зберегти</button>
    </form>
  )
}

describe('SelectField + React Hook Form', () => {
  it('початкове значення, dirty після вибору, touched після blur, reset повертає показ', async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()

    render(<RhfForm defaults={{ condition: 'NEW' }} onSubmit={onSubmit} />)

    expect(trigger()).toHaveTextContent('Нова')
    expect(screen.getByLabelText('dirty')).toHaveTextContent('false')

    await chooseOption(user, 'Стан', 'Потерта')

    expect(trigger()).toHaveTextContent('Потерта')
    expect(screen.getByLabelText('dirty')).toHaveTextContent('true')

    await user.tab()
    expect(screen.getByLabelText('touched')).toHaveTextContent('true')

    await user.click(screen.getByRole('button', { name: 'Зберегти' }))
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({ condition: 'WORN' }, expect.anything())
    })

    await user.click(screen.getByRole('button', { name: 'reset' }))
    expect(trigger()).toHaveTextContent('Нова')
    expect(screen.getByLabelText('dirty')).toHaveTextContent('false')
  })

  it('порожнє обовʼязкове поле не проходить валідацію; фокус переходить на поле з помилкою', async () => {
    const user = userEvent.setup()
    const onSubmit = jest.fn()

    render(<RhfForm defaults={{ condition: '' }} onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: 'Зберегти' }))

    expect(await screen.findByText('Оберіть стан.')).toBeInTheDocument()
    expect(trigger()).toHaveAttribute('aria-invalid', 'true')
    expect(trigger()).toHaveFocus()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
