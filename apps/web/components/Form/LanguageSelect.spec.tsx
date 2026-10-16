/** @jest-environment jsdom */

import '@testing-library/jest-dom'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { LANGUAGE_CODES } from '@bookswap/shared'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ComboboxField } from './ComboboxField'
import { LanguageSelect } from './LanguageSelect'

type Props = Partial<Parameters<typeof LanguageSelect>[0]>

function Harness({
  initial = '',
  onChange = () => undefined,
  ...props
}: Props & { initial?: string }) {
  const [value, setValue] = useState(initial)

  return (
    <LanguageSelect
      id="lang"
      label="Мова видання"
      value={value}
      onChange={(next) => {
        onChange(next)
        setValue(next)
      }}
      {...props}
    />
  )
}

const trigger = () => screen.getByRole('combobox', { name: 'Мова видання' })
const search = () => screen.findByRole('combobox', { name: 'Пошук: Мова видання' })

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(trigger())
  return search()
}

describe('LanguageSelect (BS-92)', () => {
  it('мову знаходять за українською назвою без урахування регістру й крайніх пробілів; у значення йде код', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<Harness onChange={onChange} />)
    await open(user)
    await user.keyboard('  ВʼЄТ ')

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'вʼєтнамська',
    ])

    await user.click(screen.getByRole('option', { name: 'вʼєтнамська' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('vi')
    expect(trigger()).toHaveTextContent('вʼєтнамська')
  })

  it('без збігів — «Нічого не знайдено», і пошуковий текст не стає значенням', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<Harness initial="uk" onChange={onChange} />)
    await open(user)
    await user.keyboard('клінгонська')

    expect(screen.getByText('Нічого не знайдено')).toBeVisible()
    expect(screen.queryAllByRole('option')).toHaveLength(0)

    await user.keyboard('{Enter}')
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Пошук: Мова видання' })).toBeNull()
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(trigger()).toHaveTextContent('українська')
  })

  it('закриття без вибору зберігає попереднє значення, а пошук наступного відкриття порожній', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<Harness initial="en" onChange={onChange} />)
    await open(user)
    await user.keyboard('пол')
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(trigger()).toHaveFocus()
    })
    expect(trigger()).toHaveTextContent('англійська')
    expect(await open(user)).toHaveValue('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('збережена непоширена мова показується назвою одразу, без пошуку', () => {
    render(<Harness initial="vi" />)

    expect(trigger()).toHaveTextContent('вʼєтнамська')
  })

  it('поширені мови — окремою групою нагорі, решта — «Усі мови»', async () => {
    const user = userEvent.setup()

    render(<Harness />)
    await open(user)

    const popular = screen.getByRole('group', { name: 'Поширені' })
    const all = screen.getByRole('group', { name: 'Усі мови' })

    expect(within(popular).getAllByRole('option')[0]).toHaveTextContent('українська')
    expect(within(all).queryByRole('option', { name: 'українська' })).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(LANGUAGE_CODES.length)
  })

  it('порожній вибір «Не вказано» очищає поле в «»', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<Harness initial="de" emptyLabel="Не вказано" onChange={onChange} />)
    await open(user)
    await user.click(screen.getByRole('option', { name: 'Не вказано' }))

    expect(onChange).toHaveBeenCalledWith('')
    expect(trigger()).toHaveTextContent('Не вказано')
  })

  it('обовʼязкова мова: порожнього варіанта немає, порожнє значення — лише підказка', async () => {
    const user = userEvent.setup()

    render(<Harness />)

    expect(trigger()).toHaveTextContent('Оберіть мову')
    await open(user)
    expect(screen.queryByRole('option', { name: 'Не вказано' })).toBeNull()
  })

  it('`codes` обмежує набір мов: фільтр не пропонує значень поза контрактом', async () => {
    const user = userEvent.setup()

    render(<Harness codes={['uk', 'en', 'pl']} emptyLabel="Будь-яка" />)
    await open(user)

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Будь-яка',
      'українська',
      'англійська',
      'польська',
    ])
    expect(screen.queryByRole('group', { name: 'Усі мови' })).toBeNull()
  })

  it('disabled: поле не відкривається', async () => {
    const user = userEvent.setup()

    render(
      <ComboboxField
        id="lang"
        label="Мова видання"
        value="uk"
        options={[{ value: 'uk', label: 'українська' }]}
        disabled
        onValueChange={() => undefined}
      />,
    )

    expect(trigger()).toBeDisabled()
    await user.click(trigger())
    expect(screen.queryByRole('combobox', { name: 'Пошук: Мова видання' })).toBeNull()
  })

  it('клавіатура: Enter відкриває, стрілки й Enter вибирають, фокус повертається на поле', async () => {
    const user = userEvent.setup()
    const onChange = jest.fn()

    render(<Harness onChange={onChange} />)
    await user.tab()
    expect(trigger()).toHaveFocus()

    await user.keyboard('{Enter}')
    expect(await search()).toHaveFocus()
    await user.keyboard('англ')
    await user.keyboard('{Enter}')

    expect(onChange).toHaveBeenCalledWith('en')
    await waitFor(() => {
      expect(trigger()).toHaveFocus()
    })
  })

  it('Escape у відкритому списку всередині діалогу закриває лише список', async () => {
    const user = userEvent.setup()

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Редагувати</DialogTitle>
          <Harness initial="uk" />
        </DialogContent>
      </Dialog>,
    )
    await open(user)
    await user.keyboard('{Escape}')

    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: 'Пошук: Мова видання' })).toBeNull()
    })
    expect(screen.getByRole('dialog', { name: 'Редагувати' })).toBeInTheDocument()
    expect(trigger()).toHaveFocus()
  })

  it('однакові назви в довгому списку вибираються за ID', async () => {
    const user = userEvent.setup()
    const onValueChange = jest.fn()

    render(
      <ComboboxField
        id="friend"
        label="Кому віддали"
        value=""
        placeholder="— оберіть друга —"
        options={[
          { value: 'friend-1', label: 'Олесь' },
          { value: 'friend-2', label: 'Олесь' },
          { value: 'friend-3', label: 'Марта' },
        ]}
        onValueChange={onValueChange}
      />,
    )
    await user.click(screen.getByRole('combobox', { name: 'Кому віддали' }))
    await screen.findByRole('combobox', { name: 'Пошук: Кому віддали' })
    await user.keyboard('оле')

    const [, second] = screen.getAllByRole('option', { name: 'Олесь' })

    await user.click(second as HTMLElement)

    expect(onValueChange).toHaveBeenCalledWith('friend-2')
  })
})
