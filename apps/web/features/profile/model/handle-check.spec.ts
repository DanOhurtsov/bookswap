import { handleCheckView, handleToAsk, type HandleCheckInput } from './handle-check'

const settled = { data: undefined, isError: false, isFetching: false }

function view(overrides: Partial<HandleCheckInput>) {
  return handleCheckView({
    current: 'marta',
    draft: 'marta',
    asked: undefined,
    answer: settled,
    ...overrides,
  })
}

describe('handleCheckView', () => {
  it('збережений нік — поточний, не блокує і нічого не питає', () => {
    expect(view({})).toEqual({
      message: 'Це ваш поточний нік',
      tone: 'muted',
      blocksSave: false,
      canRetry: false,
    })
  })

  it('неправильний формат — повідомлення спільної схеми, «Зберегти» чекає', () => {
    expect(view({ draft: 'ab' })).toMatchObject({
      message: 'Лише латинські літери, цифри, - та _, від 3 до 30 символів',
      tone: 'error',
      blocksSave: true,
    })
  })

  it('поки пауза не минула або відповідь не прийшла — «Перевіряємо…»', () => {
    expect(view({ draft: 'marta_reads' })).toMatchObject({
      message: 'Перевіряємо…',
      blocksSave: true,
    })
    expect(
      view({
        draft: 'marta_reads',
        asked: 'marta_reads',
        answer: { ...settled, isFetching: true },
      }),
    ).toMatchObject({ message: 'Перевіряємо…', blocksSave: true })
  })

  it('відповідь для попереднього тексту не видається за відповідь для поточного', () => {
    expect(
      view({
        draft: 'marta_reads',
        asked: 'marta_r',
        answer: { ...settled, data: { available: true } },
      }),
    ).toMatchObject({ message: 'Перевіряємо…', blocksSave: true })
  })

  it('вільний — зелений і не блокує; зайнятий — помилка й блокує', () => {
    const answered = (available: boolean) =>
      view({
        draft: 'marta_reads',
        asked: 'marta_reads',
        answer: { ...settled, data: { available } },
      })

    expect(answered(true)).toEqual({
      message: '✓ Нік вільний',
      tone: 'ok',
      blocksSave: false,
      canRetry: false,
    })
    expect(answered(false)).toEqual({
      message: 'Цей нік уже зайнятий',
      tone: 'error',
      blocksSave: true,
      canRetry: false,
    })
  })

  it('збій перевірки блокує «Зберегти» і дає перевірити ще раз (рішення PO 27.10.2026)', () => {
    expect(
      view({ draft: 'marta_reads', asked: 'marta_reads', answer: { ...settled, isError: true } }),
    ).toEqual({
      message: 'Не вдалося перевірити нік',
      tone: 'error',
      blocksSave: true,
      canRetry: true,
    })
  })
})

describe('handleToAsk', () => {
  it('питає лише про правильний нік, що відрізняється від збереженого', () => {
    expect(handleToAsk('marta', 'marta_reads')).toBe('marta_reads')
    expect(handleToAsk('marta', 'marta')).toBeUndefined()
    expect(handleToAsk('marta', 'ab')).toBeUndefined()
  })
})
