import {
  addDays,
  calendarMonthOf,
  daysBetween,
  localDay,
  movedDay,
  shiftMonth,
  shortDay,
  termFromToday,
  termOptionsOf,
} from './loan-term'

const TODAY = '2026-11-09'

describe('дні строку позики', () => {
  it('сьогодні — за місцевим календарем, навіть за пів години до півночі', () => {
    expect(localDay(new Date(2026, 10, 9, 23, 30))).toBe('2026-11-09')
  })

  it('додавання днів переходить через межу місяця, року й перехід на зимовий час', () => {
    expect(addDays('2026-11-25', 7)).toBe('2026-12-02')
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08')
    expect(addDays('2026-10-20', 14)).toBe('2026-11-03')
    expect(daysBetween('2026-10-20', '2026-11-03')).toBe(14)
  })

  it('коротка дата — як на канві', () => {
    expect(shortDay('2026-11-30')).toBe('30.11.26')
  })

  it('відстань від сьогодні — тижнями, якщо ділиться на 7, інакше днями; без «з дня передачі»', () => {
    expect(termFromToday(TODAY, '2026-11-30')).toBe('Через 3 тижні')
    expect(termFromToday(TODAY, '2026-11-16')).toBe('Через 1 тиждень')
    expect(termFromToday(TODAY, '2026-12-05')).toBe('Через 26 днів')
    expect(termFromToday(TODAY, '2026-11-10')).toBe('Через 1 день')
    expect(termFromToday(TODAY, TODAY)).toBe('Сьогодні')
    expect(termFromToday(TODAY, '2026-11-01')).toBe('Ця дата вже минула')
  })
})

describe('пресети строку', () => {
  const labels = (options: ReturnType<typeof termOptionsOf>) =>
    options.map(({ label, hint, isChecked }) => `${label}|${hint}|${String(isChecked)}`)

  it('кожен пресет — сьогодні + N днів; позначено той, чия дата збігається', () => {
    expect(labels(termOptionsOf({ today: TODAY, value: '2026-11-30', isCustom: false }))).toEqual([
      'Тиждень|до 16.11.26|false',
      '2 тижні|до 23.11.26|false',
      '3 тижні|до 30.11.26|true',
      'Місяць|до 09.12.26|false',
      'Своя дата|у календарі|false',
    ])
  })

  it('дата поза пресетами — «Своя дата» з цією датою', () => {
    const options = termOptionsOf({ today: TODAY, value: '2026-12-05', isCustom: false })

    expect(options.filter((option) => option.isChecked).map((option) => option.label)).toEqual([
      'Своя дата',
    ])
    expect(options.at(-1)?.hint).toBe('до 05.12.26')
  })

  it('обрана «Своя дата» лишається позначеною, навіть коли день збігся з пресетом', () => {
    const options = termOptionsOf({ today: TODAY, value: '2026-11-30', isCustom: true })

    expect(options.filter((option) => option.isChecked).map((option) => option.label)).toEqual([
      'Своя дата',
    ])
  })

  it('без дати нічого не позначено', () => {
    const options = termOptionsOf({ today: TODAY, value: '', isCustom: false })

    expect(options.some((option) => option.isChecked)).toBe(false)
    expect(options.at(-1)?.hint).toBe('у календарі')
  })

  it('де можна без дати, «Без дати» — перша опція й позначена, поки дату не обрано', () => {
    expect(
      labels(termOptionsOf({ today: TODAY, value: '', isCustom: false, canClear: true })),
    ).toEqual([
      'Без дати|без терміну|true',
      'Тиждень|до 16.11.26|false',
      '2 тижні|до 23.11.26|false',
      '3 тижні|до 30.11.26|false',
      'Місяць|до 09.12.26|false',
      'Своя дата|у календарі|false',
    ])
    expect(
      termOptionsOf({ today: TODAY, value: '', isCustom: false, canClear: true })[0]?.day,
    ).toBe('')
  })

  it('«Без дати» знято, щойно обрано пресет або «Своя дата» (ще без дня)', () => {
    const preset = termOptionsOf({
      today: TODAY,
      value: '2026-11-16',
      isCustom: false,
      canClear: true,
    })
    const custom = termOptionsOf({ today: TODAY, value: '', isCustom: true, canClear: true })

    expect(preset.filter((option) => option.isChecked).map((option) => option.label)).toEqual([
      'Тиждень',
    ])
    expect(custom.filter((option) => option.isChecked).map((option) => option.label)).toEqual([
      'Своя дата',
    ])
  })

  it('у власника пресет з датою позичальника каже «за запитом»', () => {
    const options = termOptionsOf({
      today: TODAY,
      value: '2026-11-30',
      isCustom: false,
      requested: '2026-11-30',
    })

    expect(options[2]?.hint).toBe('за запитом')
    expect(options[0]?.hint).toBe('до 16.11.26')
  })
})

describe('місяць календаря', () => {
  const month = calendarMonthOf({
    shown: { year: 2026, month: 10 },
    today: TODAY,
    value: '2026-11-30',
  })
  const day = (date: string) => month.cells.find((cell) => cell?.day === date)

  it('тиждень починається з понеділка: 1 листопада 2026 — неділя, перед нею 6 порожніх клітинок', () => {
    expect(month.title).toBe('Листопад 2026')
    expect(month.cells.slice(0, 6)).toEqual([null, null, null, null, null, null])
    expect(month.cells[6]?.day).toBe('2026-11-01')
    expect(month.cells).toHaveLength(36)
  })

  it('сьогодні й раніше вибрати не можна; найраніше — завтра', () => {
    expect(day('2026-11-08')?.isDisabled).toBe(true)
    expect(day(TODAY)?.isDisabled).toBe(true)
    expect(day('2026-11-10')?.isDisabled).toBe(false)
  })

  it('строк між сьогодні й датою підсвічено, сама дата — обрана, підписи для читача екрана', () => {
    expect(day(TODAY)).toMatchObject({
      isToday: true,
      isInTerm: false,
      label: '09.11.26, сьогодні',
    })
    expect(day('2026-11-20')?.isInTerm).toBe(true)
    expect(day('2026-11-30')).toMatchObject({
      isSelected: true,
      isInTerm: false,
      label: '30.11.26, обрана дата',
    })
  })

  it('назад — не раніше поточного місяця', () => {
    expect(month.canGoBack).toBe(false)
    expect(
      calendarMonthOf({ shown: { year: 2026, month: 11 }, today: TODAY, value: '' }).canGoBack,
    ).toBe(true)
  })
})

describe('гортання місяців', () => {
  it('уперед на пів року, через межу року, і назад тим самим шляхом', () => {
    let shown = { year: 2026, month: 10 }
    const titles: string[] = []

    for (let step = 0; step < 6; step += 1) {
      shown = shiftMonth(shown, 1)
      titles.push(calendarMonthOf({ shown, today: TODAY, value: '' }).title)
    }

    expect(titles).toEqual([
      'Грудень 2026',
      'Січень 2027',
      'Лютий 2027',
      'Березень 2027',
      'Квітень 2027',
      'Травень 2027',
    ])
    expect(shiftMonth(shown, -6)).toEqual({ year: 2026, month: 10 })
  })

  it('місяць наперед: усі дні доступні, а 29 лютого 2027 немає', () => {
    const february = calendarMonthOf({ shown: { year: 2027, month: 1 }, today: TODAY, value: '' })
    const days = february.cells.filter((cell) => cell !== null)

    expect(days).toHaveLength(28)
    expect(days.every((cell) => !cell.isDisabled)).toBe(true)
    expect(february.canGoBack).toBe(true)
  })
})

describe('клавіатура календаря', () => {
  it('стрілки — день і тиждень, Home/End — межі тижня, PageUp/PageDown — місяць', () => {
    expect(movedDay('2026-11-30', 'ArrowRight')).toBe('2026-12-01')
    expect(movedDay('2026-11-30', 'ArrowUp')).toBe('2026-11-23')
    expect(movedDay('2026-11-26', 'Home')).toBe('2026-11-23')
    expect(movedDay('2026-11-26', 'End')).toBe('2026-11-29')
    expect(movedDay('2027-01-31', 'PageDown')).toBe('2027-02-28')
    expect(movedDay('2026-11-30', 'PageUp')).toBe('2026-10-30')
    expect(movedDay('2026-11-30', 'Enter')).toBeNull()
  })
})
