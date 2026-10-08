import { NOTIFICATION_TYPE, type Channel } from '@bookswap/shared'
import { renderNotification, type NotificationView } from './notification-renderer'

const base: NotificationView = {
  type: 'LOAN_REQUESTED',
  payload: { loanId: 'loan-1', copyId: 'copy-1', actorId: 'user-oles' },
  actorName: 'Олесь',
  bookTitle: 'Шантарам',
  webOrigin: 'https://bookswap.example',
}

describe('renderNotification: сповіщення запису наявної позики (Stage 10, 10e)', () => {
  const record = (type: NotificationView['type']) => renderNotification({ ...base, type })

  it('PROPOSED: просить підтвердити або відхилити й попереджає про недоступність; без кнопок Telegram', () => {
    const rendered = record('LOAN_RECORD_PROPOSED')

    expect(rendered.subject).toContain('Шантарам')
    expect(rendered.body).toContain('Підтвердьте')
    expect(rendered.body).toContain('недоступна іншим')
    expect(rendered.body).toContain('/loans?loanId=loan-1')
    expect(rendered.actions).toEqual([])
  })

  it('AMENDED веде до перегляду нових дат; CONFIRMED/DECLINED/WITHDRAWN — інформаційні', () => {
    expect(record('LOAN_RECORD_AMENDED').body).toContain('нові дати')
    expect(record('LOAN_RECORD_DECLINED').body).toContain('знову вільна')

    for (const type of ['LOAN_RECORD_CONFIRMED', 'LOAN_RECORD_WITHDRAWN'] as const) {
      expect(record(type).actions).toEqual([])
    }
  })

  it('ці тексти не називають запис «погодженим запитом» (D6: запиту не було)', () => {
    for (const type of [
      'LOAN_RECORD_PROPOSED',
      'LOAN_RECORD_AMENDED',
      'LOAN_RECORD_CONFIRMED',
      'LOAN_RECORD_DECLINED',
      'LOAN_RECORD_WITHDRAWN',
    ] as const) {
      expect(record(type).subject).not.toMatch(/запит на|погоджено|просить/i)
    }
  })
})

describe('renderNotification: відповідь гостя (Stage 10, 10i.3)', () => {
  const guest = (type: NotificationView['type'], channel: Channel = 'IN_APP') =>
    renderNotification(
      {
        ...base,
        type,
        payload: { loanId: 'loan-1', copyId: 'copy-1', confirmationId: 'conf-1' },
        actorName: null,
      },
      channel,
    )

  it('IN_APP: змістовний текст без кнопок, посилання на екран гостьових позик власника', () => {
    for (const type of ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] as const) {
      const rendered = guest(type)

      expect(rendered.actions).toEqual([])
      expect(rendered.subject).toContain('Шантарам')
      expect(rendered.body).toContain('/loans/guest?confirmationId=conf-1')
      expect(rendered.body).not.toContain('/loans?loanId')
    }
  })

  it('IN_APP DENIED називає розбіжність, а не повернення, і не обіцяє звільнення примірника', () => {
    const rendered = guest('GUEST_LOAN_DENIED')

    expect(rendered.subject).toContain('заперечує')
    expect(rendered.body).toContain('не повернення')
    expect(rendered.body).toContain('недоступним')
  })

  it('IN_APP не стверджує доведену особу й не має ні імені гостя, ні «хтось із друзів»', () => {
    for (const type of ['GUEST_LOAN_RECEIVED', 'GUEST_LOAN_DENIED'] as const) {
      const rendered = guest(type)

      expect(`${rendered.subject}\n${rendered.body}`).not.toMatch(
        /Хтось із друзів|особу|ідентифік/i,
      )
    }
  })

  it('EMAIL: строго загальний і однаковий для обох типів, без книжки, результату та id запиту', () => {
    const received = guest('GUEST_LOAN_RECEIVED', 'EMAIL')
    const denied = guest('GUEST_LOAN_DENIED', 'EMAIL')

    expect(received).toEqual(denied)
    expect(received.subject).toBe('У вас нове повідомлення в BookSwap')
    expect(received.body).toBe(
      'У вас нове повідомлення в BookSwap\n\nЩоб його прочитати, увійдіть у BookSwap: https://bookswap.example/login',
    )
    expect(received.actions).toEqual([])
    expect(`${received.subject}${received.body}`).not.toMatch(
      /Шантарам|conf-1|loan-1|copy-1|гість|отрим|заперечує/i,
    )
  })

  it('TELEGRAM для цих типів не рендериться', () => {
    expect(() => guest('GUEST_LOAN_RECEIVED', 'TELEGRAM')).toThrow()
    expect(() => guest('GUEST_LOAN_DENIED', 'TELEGRAM')).toThrow()
  })
})

describe('renderNotification', () => {
  it.each([...NOTIFICATION_TYPE])('дає непорожні тему й тіло для %s', (type) => {
    const rendered = renderNotification({ ...base, type })

    expect(rendered.subject.length).toBeGreaterThan('BookSwap: '.length)
    expect(rendered.body).toContain(base.webOrigin)
  })

  it('підставляє ім’я актора й назву твору', () => {
    const rendered = renderNotification(base)

    expect(rendered.subject).toContain('Олесь')
    expect(rendered.subject).toContain('Шантарам')
  })

  /**
   * Контекст читається окремими запитами й може не дочитатися: користувача
   * видалили, примірник знесли разом із виданням. Текст мусить лишитися
   * зрозумілим, а не перетворитися на «null просить null» — саме тому підстановки
   * мають запасні формулювання, а не `?? ''`.
   */
  it('лишається читабельним без контексту', () => {
    const rendered = renderNotification({ ...base, actorName: null, bookTitle: null })

    expect(rendered.subject).not.toContain('null')
    expect(rendered.body).not.toContain('null')
    expect(rendered.body).not.toContain('undefined')
  })

  it('веде на сторінку лоану, коли в payload є loanId', () => {
    expect(renderNotification(base).body).toContain('/loans?loanId=loan-1')
  })

  it('події дружби ведуть на /friends, а не на лоани', () => {
    const rendered = renderNotification({
      ...base,
      type: 'FRIEND_REQUESTED',
      payload: { actorId: 'user-oles', friendshipId: 'friendship-1' },
    })

    expect(rendered.body).toContain('/friends')
    expect(rendered.body).not.toContain('/loans')
  })

  it('без loanId посилання не ламається', () => {
    const rendered = renderNotification({ ...base, payload: {} })

    expect(rendered.body).toContain('/notifications')
  })
})

describe('інлайн-кнопки (§7.4)', () => {
  it('LOAN_REQUESTED несе approve і reject', () => {
    const { actions } = renderNotification(base)

    expect(actions.map((action) => action.data)).toEqual([
      'loan:approve:loan-1',
      'loan:reject:loan-1',
    ])
  })

  /**
   * §7.4: `callback_data` приходить від клієнта, і кожна кнопка — це рядок, який
   * обробник зобов'язаний авторизувати. Тому їх рівно там, де вони потрібні.
   */
  it.each([...NOTIFICATION_TYPE].filter((type) => type !== 'LOAN_REQUESTED'))(
    '%s кнопок не має',
    (type) => {
      expect(renderNotification({ ...base, type }).actions).toEqual([])
    },
  )

  it('без loanId кнопок не буде навіть у LOAN_REQUESTED', () => {
    expect(renderNotification({ ...base, payload: { copyId: 'copy-1' } }).actions).toEqual([])
  })

  /** Telegram обмежує `callback_data` 64 байтами — довша кнопка просто не надішлеться. */
  it('callback_data вкладається в ліміт Telegram', () => {
    const longId = 'c'.repeat(32)
    const { actions } = renderNotification({ ...base, payload: { loanId: longId } })

    for (const action of actions) {
      expect(Buffer.byteLength(action.data, 'utf8')).toBeLessThanOrEqual(64)
    }
  })

  it('тіло лишається осмисленим без кнопок — канали без них теж є', () => {
    const { body } = renderNotification(base)

    expect(body).toContain('Погодьте або відхиліть запит.')
  })
})

describe('§7.5: дайджест агрегує', () => {
  const digest = (count: number, type: 'LOAN_DUE_SOON' | 'LOAN_OVERDUE' = 'LOAN_OVERDUE') =>
    renderNotification({
      ...base,
      type,
      payload: { count: String(count), loanId: 'loan-1', copyId: 'copy-1', loanIds: 'loan-1' },
    })

  /**
   * Головна причина, чому §7.5 називає цю групу дайджестом: людина з двадцятьма
   * простроченими книжками не має отримати двадцять повідомлень. А отримавши одне,
   * не має прочитати в ньому назву однієї книжки — інакше поверне її й вважатиме
   * питання закритим.
   */
  it('на кількох книжках не називає одну', () => {
    const rendered = digest(5)

    expect(rendered.subject).toContain('5 книжок')
    expect(rendered.subject).not.toContain('Шантарам')
  })

  it('на одній книжці називає її', () => {
    expect(digest(1).subject).toContain('Шантарам')
  })

  it('на одній книжці без назви каже просто «книжку»', () => {
    const rendered = renderNotification({
      ...base,
      type: 'LOAN_OVERDUE',
      bookTitle: null,
      payload: { count: '1', loanId: 'loan-1' },
    })

    expect(rendered.subject).toContain('книжку')
  })

  it.each([
    [2, '2 книжки'],
    [4, '4 книжки'],
    [5, '5 книжок'],
    [11, '11 книжок'],
    [12, '12 книжок'],
    [21, '21 книжку'],
    [22, '22 книжки'],
    [25, '25 книжок'],
  ])('відмінює: %i → %s', (count, expected) => {
    // Без відмінювання виходить «21 книжок» — дрібниця, яку видно всім і завжди.
    expect(digest(count).subject).toContain(expected)
  })

  it('дайджест на кілька книжок веде до списку, а не до першої з них', () => {
    expect(digest(3).body).toContain('/loans?role=borrower')
    expect(digest(1).body).toContain('/loans?loanId=loan-1')
  })

  it('зіпсований count не ламає текст', () => {
    const rendered = renderNotification({
      ...base,
      type: 'LOAN_OVERDUE',
      payload: { count: 'багато', loanId: 'loan-1' },
    })

    expect(rendered.subject).not.toContain('NaN')
    expect(rendered.subject).toContain('Шантарам')
  })

  it('дайджест кнопок не має — з нього немає дії на одну книжку', () => {
    expect(digest(3).actions).toEqual([])
    expect(digest(1, 'LOAN_DUE_SOON').actions).toEqual([])
  })
})
