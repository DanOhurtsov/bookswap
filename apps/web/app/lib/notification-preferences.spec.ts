import {
  NOTIFICATION_TYPE,
  PREFERENCE_CHANNEL,
  defaultPreferenceEnabled,
  isGuestResponseNotificationType,
} from '@bookswap/shared'
import {
  changedCells,
  channelStates,
  formatCountdown,
  linkTimeLeftMs,
  telegramChannelAction,
  toMatrix,
  toggleCell,
} from './notification-preferences'
import type {
  ChannelAvailability,
  NotificationChannels,
  NotificationPreference,
} from '@bookswap/shared'

const channels: NotificationChannels = {
  inApp: { configured: true, connected: true, available: true },
  email: {
    address: 'marta@example.com',
    verified: true,
    configured: true,
    connected: true,
    available: true,
  },
  telegram: { configured: true, connected: false, available: false },
}

const full = (telegramLinked: boolean): NotificationPreference[] =>
  NOTIFICATION_TYPE.flatMap((type) =>
    PREFERENCE_CHANNEL.map((channel) => ({
      type,
      channel,
      enabled: defaultPreferenceEnabled(type, channel, { telegramLinked }),
    })),
  )

describe('toMatrix', () => {
  it('покриває всі клітинки матриці — три канали, не два', () => {
    const matrix = toMatrix(full(false), false)

    for (const type of NOTIFICATION_TYPE) {
      for (const channel of PREFERENCE_CHANNEL) {
        expect(typeof matrix[type][channel]).toBe('boolean')
      }
    }

    expect(Object.keys(matrix.LOAN_REQUESTED).sort()).toEqual(['EMAIL', 'IN_APP', 'TELEGRAM'])
  })

  it('бере збережене значення там, де воно є', () => {
    const matrix = toMatrix([{ type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false }], false)

    expect(matrix.LOAN_REQUESTED.EMAIL).toBe(false)
  })

  /**
   * Сервер віддає матрицю повністю, але покладатися на це не можна: старіший
   * бек після появи нового типу події просто не знав би про його клітинку, і
   * сторінка або впала б, або показала б `undefined` як «вимкнено».
   */
  it('домальовує відсутні клітинки дефолтами §7.6', () => {
    const matrix = toMatrix([], false)

    expect(matrix.LOAN_REQUESTED.IN_APP).toBe(true)
    expect(matrix.LOAN_REQUESTED.EMAIL).toBe(true)
    expect(matrix.LOAN_RETURNED.EMAIL).toBe(false)
    expect(matrix.LOAN_REQUESTED.TELEGRAM).toBe(false)
  })

  /** §7.6: in-app увімкнений за замовчуванням, але це саме дефолт, а не константа. */
  it('вимкнений IN_APP зберігається, а не ігнорується', () => {
    const matrix = toMatrix([{ type: 'LOAN_RETURNED', channel: 'IN_APP', enabled: false }], false)

    expect(matrix.LOAN_RETURNED.IN_APP).toBe(false)
    expect(matrix.LOAN_REQUESTED.IN_APP).toBe(true)
  })

  it('після прив’язки Telegram його дефолти вмикаються', () => {
    const matrix = toMatrix([], true)

    for (const type of NOTIFICATION_TYPE) {
      // Stage 10 (10i.3): відповіді гостя в Telegram не вмикаються ніколи.
      expect(matrix[type].TELEGRAM).toBe(!isGuestResponseNotificationType(type))
    }
  })

  it('відповіді гостя: IN_APP і EMAIL увімкнені за замовчуванням, TELEGRAM вимкнений навіть після прив’язки', () => {
    for (const linked of [false, true]) {
      const matrix = toMatrix([], linked)

      for (const type of ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] as const) {
        expect(matrix[type]).toEqual({ IN_APP: true, EMAIL: true, TELEGRAM: false })
      }
    }
  })

  it('збережене вимкнення переважає дефолт навіть після прив’язки', () => {
    const matrix = toMatrix([{ type: 'LOAN_OVERDUE', channel: 'TELEGRAM', enabled: false }], true)

    expect(matrix.LOAN_OVERDUE.TELEGRAM).toBe(false)
    expect(matrix.LOAN_REQUESTED.TELEGRAM).toBe(true)
  })
})

describe('toggleCell', () => {
  it('перемикає рівно одну клітинку', () => {
    const before = toMatrix(full(false), false)
    const after = toggleCell(before, 'LOAN_REQUESTED', 'EMAIL')

    expect(after.LOAN_REQUESTED.EMAIL).toBe(!before.LOAN_REQUESTED.EMAIL)
    expect(after.LOAN_APPROVED.EMAIL).toBe(before.LOAN_APPROVED.EMAIL)
    expect(after.LOAN_REQUESTED.TELEGRAM).toBe(before.LOAN_REQUESTED.TELEGRAM)
    expect(after.LOAN_REQUESTED.IN_APP).toBe(before.LOAN_REQUESTED.IN_APP)
  })

  it('не мутує попередню матрицю — це стан React', () => {
    const before = toMatrix(full(false), false)
    const snapshot = before.LOAN_REQUESTED.EMAIL

    toggleCell(before, 'LOAN_REQUESTED', 'EMAIL')

    expect(before.LOAN_REQUESTED.EMAIL).toBe(snapshot)
  })
})

describe('changedCells', () => {
  it('без змін нічого не надсилає', () => {
    const matrix = toMatrix(full(false), false)

    expect(changedCells(matrix, matrix)).toEqual([])
  })

  /**
   * Надсилати матрицю цілком означало б матеріалізувати всі 30 рядків у базі,
   * включно з незайманими. Після цього зміна дефолту §7.6 не подіяла б на жодного
   * наявного користувача: у всіх лежав би явно збережений старий стан.
   */
  it('надсилає тільки те, що людина справді змінила', () => {
    const before = toMatrix(full(false), false)
    const after = toggleCell(
      toggleCell(before, 'LOAN_REQUESTED', 'EMAIL'),
      'LOAN_RETURNED',
      'EMAIL',
    )

    expect(changedCells(before, after)).toEqual([
      { type: 'LOAN_REQUESTED', channel: 'EMAIL', enabled: false },
      { type: 'LOAN_RETURNED', channel: 'EMAIL', enabled: true },
    ])
  })

  it('вимкнення IN_APP теж потрапляє в запит', () => {
    const before = toMatrix(full(false), false)
    const after = toggleCell(before, 'LOAN_OVERDUE', 'IN_APP')

    expect(changedCells(before, after)).toEqual([
      { type: 'LOAN_OVERDUE', channel: 'IN_APP', enabled: false },
    ])
  })

  it('подвійне перемикання нічого не змінює', () => {
    const before = toMatrix(full(false), false)
    const after = toggleCell(
      toggleCell(before, 'FRIEND_ACCEPTED', 'EMAIL'),
      'FRIEND_ACCEPTED',
      'EMAIL',
    )

    expect(changedCells(before, after)).toEqual([])
  })

  it('жодна клітинка не згадується двічі — інакше PUT дасть 400', () => {
    const before = toMatrix(full(false), false)
    let after = before

    for (const type of NOTIFICATION_TYPE) {
      for (const channel of PREFERENCE_CHANNEL) {
        after = toggleCell(after, type, channel)
      }
    }

    const changed = changedCells(before, after)
    const keys = changed.map((row) => `${row.type}:${row.channel}`)

    expect(new Set(keys).size).toBe(keys.length)
    expect(changed).toHaveLength(NOTIFICATION_TYPE.length * PREFERENCE_CHANNEL.length)
  })
})

describe('channelStates', () => {
  it('описує кожну колонку матриці рівно раз', () => {
    expect(
      channelStates(channels)
        .map((state) => state.channel)
        .sort(),
    ).toEqual([...PREFERENCE_CHANNEL].sort())
  })

  /**
   * `PUT` із `TELEGRAM: true` без прив'язки дає 409, тож форма, яка дозволяє це
   * натиснути, обіцяє те, чого система не зробить.
   */
  it('колонка Telegram не редагується без прив’язки', () => {
    const telegram = channelStates(channels).find((state) => state.channel === 'TELEGRAM')

    expect(telegram?.editable).toBe(false)
    expect(telegram?.detail).toBe('Не підключено')
  })

  it('після прив’язки колонка редагується', () => {
    const states = channelStates({
      ...channels,
      telegram: { configured: true, connected: true, available: true },
    })

    expect(states.find((state) => state.channel === 'TELEGRAM')?.editable).toBe(true)
  })

  /**
   * Неналаштований бот і непідключений акаунт — різні відповіді на «чому не
   * працює». У першому випадку кнопка «Підключити» не допоможе, тож UI має
   * сказати про сервер, а не пропонувати дію.
   */
  it('неналаштований бот описується інакше, ніж непідключений акаунт', () => {
    const states = channelStates({
      ...channels,
      telegram: { configured: false, connected: false, available: false },
    })
    const telegram = states.find((state) => state.channel === 'TELEGRAM')

    expect(telegram?.configured).toBe(false)
    expect(telegram?.editable).toBe(false)
    expect(telegram?.detail).toContain('не налаштований')
  })

  /**
   * Непідтверджена пошта колонку не блокує: §6.1 підтверджують тим самим листом,
   * і забороняти налаштування наперед було б колом. Але доставки поки немає — і
   * сказати про це треба прямо.
   */
  it('непідтверджена пошта редагується, але позначена як недоступна', () => {
    const states = channelStates({
      ...channels,
      email: { ...channels.email, verified: false, connected: false, available: false },
    })
    const email = states.find((state) => state.channel === 'EMAIL')

    expect(email?.editable).toBe(true)
    expect(email?.available).toBe(false)
    expect(email?.detail).toContain('не підтверджено')
  })

  it('IN_APP доступний завжди — ні конфігурації, ні підключення не потребує', () => {
    const inApp = channelStates(channels).find((state) => state.channel === 'IN_APP')

    expect(inApp?.available).toBe(true)
    expect(inApp?.editable).toBe(true)
  })
})

describe('§7.4: життя посилання на бота', () => {
  const expiresAt = '2026-06-01T10:10:00.000Z'
  const at = (iso: string): number => new Date(iso).getTime()

  it('рахує залишок від переданого «зараз»', () => {
    expect(linkTimeLeftMs(expiresAt, at('2026-06-01T10:00:00.000Z'))).toBe(10 * 60_000)
  })

  /**
   * Протухле посилання — `null`, а не нуль: UI має його **прибрати**, а не
   * показувати таймер на нулі. Натискання на нього закінчилося б відмовою бота,
   * і людина вирішила б, що зламався сервіс.
   */
  it('протухле дає null, а не нуль', () => {
    expect(linkTimeLeftMs(expiresAt, at('2026-06-01T10:10:00.000Z'))).toBeNull()
    expect(linkTimeLeftMs(expiresAt, at('2026-06-01T10:11:00.000Z'))).toBeNull()
  })

  it('зіпсована дата вважається протухлою', () => {
    expect(linkTimeLeftMs('не дата', at('2026-06-01T10:00:00.000Z'))).toBeNull()
  })

  it.each([
    [600_000, '10:00'],
    [59_000, '0:59'],
    [1_000, '0:01'],
    [500, '0:01'],
  ])('форматує %i мс як %s', (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected)
  })
})

/**
 * §5.4 дефекту UI: `connected` перевіряється РАНІШЕ за `configured`, інакше
 * підключений акаунт на сервері без токена бота лишається без способу
 * відв'язатися через UI, хоча `DELETE /me/telegram` на бекенді від
 * `configured` не залежить узагалі.
 */
describe('telegramChannelAction', () => {
  const state = (overrides: Partial<ChannelAvailability>): ChannelAvailability => ({
    configured: true,
    connected: false,
    available: false,
    ...overrides,
  })

  it('підключено, бот налаштований — відключити', () => {
    expect(telegramChannelAction(state({ connected: true, available: true }))).toBe('unlink')
  })

  /**
   * Головний сценарій дефекту: бот перестав бути налаштованим на сервері
   * ПІСЛЯ того, як акаунт уже підключився. `connected` не залежить від
   * `configured` — рядок `User.telegramChatId` нікуди не дівається разом із
   * `TELEGRAM_BOT_TOKEN`.
   */
  it('підключено, а бот РАПТОМ не налаштований — усе одно відключити', () => {
    expect(
      telegramChannelAction(state({ connected: true, configured: false, available: false })),
    ).toBe('unlink')
  })

  it('не підключено, бот не налаштований — недоступно', () => {
    expect(telegramChannelAction(state({ connected: false, configured: false }))).toBe(
      'unavailable',
    )
  })

  it('не підключено, бот налаштований — підключити', () => {
    expect(telegramChannelAction(state({ connected: false, configured: true }))).toBe('connect')
  })
})
