/** @jest-environment jsdom */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import type { SearchPageSize } from '@bookswap/shared'
import type { NextPage } from '@/app/lib/search-page'
import { SearchPagination } from './SearchPagination'

function renderPagination(
  overrides: Partial<{
    page: number
    pageSize: SearchPageSize
    next: NextPage
    currentHasRows: boolean
  }> = {},
) {
  const onPageSizeChange = jest.fn()

  render(
    <SearchPagination
      page={1}
      pageSize={12}
      next="NONE"
      currentHasRows
      hrefFor={({ page, pageSize }) => `/catalog?page=${String(page)}&pageSize=${String(pageSize)}`}
      onPageSizeChange={onPageSizeChange}
      {...overrides}
    />,
  )

  return { onPageSizeChange }
}

describe('SearchPagination', () => {
  it('єдина сторінка без наступної: навігації немає, лишається вибір розміру', () => {
    renderPagination()

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Результатів на сторінці' })).toHaveTextContent(
      '12',
    )
  })

  it('посилання — справжні посилання (role=link), а не кнопки', () => {
    renderPagination({ page: 2, next: 'PROVEN' })

    const nav = screen.getByRole('navigation', { name: 'Сторінки результатів' })

    expect(screen.getAllByRole('link').length).toBeGreaterThan(0)
    expect(nav.querySelectorAll('[role="button"]')).toHaveLength(0)
  })

  it('поточна сторінка має aria-current і доступну назву', () => {
    renderPagination({ page: 2, next: 'PROVEN' })

    const current = screen.getByRole('link', { name: 'Сторінка 2, поточна' })

    expect(current).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Сторінка 1' })).not.toHaveAttribute('aria-current')
  })

  it('називає попередню й наступну сторінки', () => {
    renderPagination({ page: 2, next: 'PROVEN' })

    expect(screen.getByRole('link', { name: 'Попередня сторінка' })).toHaveAttribute(
      'href',
      '/catalog?page=1&pageSize=12',
    )
    expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toHaveAttribute(
      'href',
      '/catalog?page=3&pageSize=12',
    )
  })

  it('номер наступної сторінки — лише коли вона доведена', () => {
    renderPagination({ page: 2, next: 'PROVEN' })
    expect(screen.getByRole('link', { name: 'Сторінка 3' })).toBeInTheDocument()
  })

  it('без доказу («можливо») є Далі, але немає номера наступної', () => {
    renderPagination({ page: 2, next: 'POSSIBLE' })

    expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Сторінка 3' })).not.toBeInTheDocument()
  })

  it('NONE — ні Далі, ні номера наступної (максимальна сторінка)', () => {
    renderPagination({ page: 20, next: 'NONE' })

    expect(screen.queryByRole('link', { name: 'Наступна сторінка' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Сторінка 21' })).not.toBeInTheDocument()
  })

  it('порожня поточна сторінка не вигадує попередніх номерів, окрім першої', () => {
    renderPagination({ page: 5, currentHasRows: false })

    expect(screen.queryByRole('link', { name: 'Сторінка 4' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Сторінка 1' })).toBeInTheDocument()
  })

  it('загальної кількості сторінок немає ніде', () => {
    renderPagination({ page: 3, next: 'PROVEN' })

    expect(screen.queryByText(/з \d+/)).not.toBeInTheDocument()
  })

  it('посилання несуть поточний розмір сторінки', () => {
    renderPagination({ page: 1, pageSize: 48, next: 'PROVEN' })

    expect(screen.getByRole('link', { name: 'Наступна сторінка' })).toHaveAttribute(
      'href',
      '/catalog?page=2&pageSize=48',
    )
  })

  it('вибір 12 / 24 / 36 / 48 повідомляє обробник', async () => {
    const { onPageSizeChange } = renderPagination()
    const user = userEvent.setup()

    await user.click(screen.getByRole('combobox', { name: 'Результатів на сторінці' }))

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      '12',
      '24',
      '36',
      '48',
    ])

    await user.click(screen.getByRole('option', { name: '36' }))

    expect(onPageSizeChange).toHaveBeenCalledWith(36)
  })
})
