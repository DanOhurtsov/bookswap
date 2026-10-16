import { screen } from '@testing-library/react'

type Clicker = { click: (element: Element) => Promise<void> }
type Typist = Clicker & { keyboard: (text: string) => Promise<void> }

/**
 * Test-only: picks an option of a `SelectField`, `ComboboxField` or `LanguageSelect` the way a
 * person does — opens the field by its label, then clicks the option by its visible name.
 */
export async function chooseOption(
  user: Clicker,
  field: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: field }))
  await user.click(await screen.findByRole('option', { name: option }))
}

/** Test-only: the same through a combobox's search box — types `query`, then picks `option`. */
export async function searchAndChooseOption(
  user: Typist,
  field: string,
  query: string,
  option: string | RegExp,
): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: field }))
  await screen.findByRole('combobox', { name: `Пошук: ${field}` })
  await user.keyboard(query)
  await user.click(await screen.findByRole('option', { name: option }))
}
