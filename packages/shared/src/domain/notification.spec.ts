import { PREFERENCE_CHANNEL } from './channel'
import {
  DIGEST_NOTIFICATION_TYPE,
  FLOW_CRITICAL_NOTIFICATION_TYPE,
  IMMEDIATE_NOTIFICATION_TYPE,
  GUEST_RESPONSE_NOTIFICATION_TYPE,
  NOTIFICATION_TYPE,
  defaultPreferenceEnabled,
  isDigestNotificationType,
  isGuestResponseNotificationType,
} from './notification'
import type { NotificationType } from './notification'

describe('§7.5: негайно vs дайджест', () => {
  /**
   * Найважливіша властивість розбиття — воно **покриття без перетину**. Тип, що
   * випав з обох списків, не надсилатиметься ніколи; тип, що потрапив в обидва,
   * прийде і негайно, і дайджестом. Обидві поломки тихі, тому перевіряються тут,
   * а не в коді, який ними користується.
   */
  it('розбиває всі типи §4.8 без перетину', () => {
    const immediate = new Set<string>(IMMEDIATE_NOTIFICATION_TYPE)
    const digest = new Set<string>(DIGEST_NOTIFICATION_TYPE)

    for (const type of NOTIFICATION_TYPE) {
      expect(immediate.has(type) !== digest.has(type)).toBe(true)
    }

    expect(immediate.size + digest.size).toBe(NOTIFICATION_TYPE.length)
  })

  it('дайджест — рівно LOAN_DUE_SOON і LOAN_OVERDUE', () => {
    expect([...DIGEST_NOTIFICATION_TYPE].sort()).toEqual(['LOAN_DUE_SOON', 'LOAN_OVERDUE'])
  })

  it.each(DIGEST_NOTIFICATION_TYPE)('%s розпізнається як дайджестовий', (type) => {
    expect(isDigestNotificationType(type)).toBe(true)
  })

  it.each(IMMEDIATE_NOTIFICATION_TYPE)('%s дайджестовим не є', (type) => {
    expect(isDigestNotificationType(type)).toBe(false)
  })
})

describe('§7.6: дефолти матриці', () => {
  /**
   * §7.6: «Дефолти: усе в IN_APP». Вимкнути його можна — але не за
   * замовчуванням: подія без жодного каналу була б невидимою навіть на власній
   * сторінці сповіщень.
   */
  it('IN_APP увімкнений за замовчуванням для кожного типу', () => {
    for (const type of NOTIFICATION_TYPE) {
      expect(defaultPreferenceEnabled(type, 'IN_APP', { telegramLinked: false })).toBe(true)
      expect(defaultPreferenceEnabled(type, 'IN_APP', { telegramLinked: true })).toBe(true)
    }
  })

  it('до прив’язки Telegram уся його колонка вимкнена', () => {
    for (const type of NOTIFICATION_TYPE) {
      expect(defaultPreferenceEnabled(type, 'TELEGRAM', { telegramLinked: false })).toBe(false)
    }
  })

  it('після прив’язки «усе в TELEGRAM» — крім відповідей гостя', () => {
    for (const type of NOTIFICATION_TYPE) {
      expect(defaultPreferenceEnabled(type, 'TELEGRAM', { telegramLinked: true })).toBe(
        !isGuestResponseNotificationType(type),
      )
    }
  })

  it('email за замовчуванням — критичне для флоу та відповіді гостя (лист загальний)', () => {
    const critical = new Set<string>([
      ...FLOW_CRITICAL_NOTIFICATION_TYPE,
      ...GUEST_RESPONSE_NOTIFICATION_TYPE,
    ])

    for (const type of NOTIFICATION_TYPE) {
      expect(defaultPreferenceEnabled(type, 'EMAIL', { telegramLinked: false })).toBe(
        critical.has(type),
      )
    }
  })

  /**
   * Прив'язка Telegram не має права мовчки прибирати листи: §7.6 дає «можливість
   * вимкнути email», а не вимикає його сама. Інакше людина, яка під'єднала бота
   * й потім видалила чат, лишилася б без жодного каналу, нічого не вимикаючи.
   */
  it('прив’язка Telegram не змінює дефолти email', () => {
    for (const type of NOTIFICATION_TYPE) {
      expect(defaultPreferenceEnabled(type, 'EMAIL', { telegramLinked: true })).toBe(
        defaultPreferenceEnabled(type, 'EMAIL', { telegramLinked: false }),
      )
    }
  })

  it('критичні типи лишаються підмножиною §4.8', () => {
    const all = new Set<string>(NOTIFICATION_TYPE)

    for (const type of FLOW_CRITICAL_NOTIFICATION_TYPE) {
      expect(all.has(type)).toBe(true)
    }
  })

  it('визначена для кожної клітинки матриці', () => {
    for (const type of NOTIFICATION_TYPE satisfies readonly NotificationType[]) {
      for (const channel of PREFERENCE_CHANNEL) {
        expect(typeof defaultPreferenceEnabled(type, channel, { telegramLinked: true })).toBe(
          'boolean',
        )
      }
    }
  })
})

describe('Stage 10 (10i.3): відповіді гостя', () => {
  it('це рівно RECEIVED і DENIED, і вони негайні, а не дайджестові', () => {
    expect([...GUEST_RESPONSE_NOTIFICATION_TYPE].sort()).toEqual([
      'GUEST_LOAN_DENIED',
      'GUEST_LOAN_RECEIVED',
    ])

    for (const type of GUEST_RESPONSE_NOTIFICATION_TYPE) {
      expect((IMMEDIATE_NOTIFICATION_TYPE as readonly string[]).includes(type)).toBe(true)
      expect(isDigestNotificationType(type)).toBe(false)
    }
  })

  it.each(GUEST_RESPONSE_NOTIFICATION_TYPE)(
    '%s: IN_APP і EMAIL увімкнені за замовчуванням, TELEGRAM — ніколи, навіть з прив’язаним чатом',
    (type) => {
      for (const telegramLinked of [false, true]) {
        expect(defaultPreferenceEnabled(type, 'IN_APP', { telegramLinked })).toBe(true)
        expect(defaultPreferenceEnabled(type, 'EMAIL', { telegramLinked })).toBe(true)
        expect(defaultPreferenceEnabled(type, 'TELEGRAM', { telegramLinked })).toBe(false)
      }
    },
  )

  it('решта типів не позначена як відповіді гостя', () => {
    expect(isGuestResponseNotificationType('LOAN_REQUESTED')).toBe(false)
    expect(isGuestResponseNotificationType('LOAN_RECORD_PROPOSED')).toBe(false)
  })
})
