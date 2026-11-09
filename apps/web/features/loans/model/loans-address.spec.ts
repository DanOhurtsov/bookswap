import {
  LOANS_HISTORY_HREF,
  LOANS_TABS,
  loanHref,
  loansBackHref,
  loansFiltersHref,
  loansTabHref,
  readLoansAddress,
  statusFiltersOf,
  tabOf,
} from './loans-address'

const read = (query: string) => readLoansAddress(new URLSearchParams(query))

const NO_FILTERS = { query: '', status: null }

describe('адреса розділу «Позичання» (BS-143, BS-153)', () => {
  it('вкладки йдуть у порядку макета: «Усі», «Я позичаю», «У мене позичають», «Історія»', () => {
    expect(LOANS_TABS).toEqual(['all', 'borrower', 'owner', 'history'])
    expect(LOANS_HISTORY_HREF).toBe('/loans?tab=history')
  })

  it.each([
    ['', { mode: 'list', side: 'all', filters: NO_FILTERS }],
    ['role=owner', { mode: 'list', side: 'owner', filters: NO_FILTERS }],
    ['role=borrower', { mode: 'list', side: 'borrower', filters: NO_FILTERS }],
    ['role=nobody', { mode: 'list', side: 'all', filters: NO_FILTERS }],
    ['tab=unknown&role=borrower', { mode: 'list', side: 'borrower', filters: NO_FILTERS }],
    ['tab=HISTORY', { mode: 'list', side: 'all', filters: NO_FILTERS }],
    ['historyView=lent', { mode: 'list', side: 'all', filters: NO_FILTERS }],
    ['tab=history', { mode: 'history', filters: NO_FILTERS }],
    ['tab=history&role=borrower', { mode: 'history', filters: NO_FILTERS }],
    // BS-142: an old `historyView` opens the one shared history — it no longer picks a side.
    ['tab=history&historyView=borrowed', { mode: 'history', filters: NO_FILTERS }],
    ['tab=history&historyView=lent', { mode: 'history', filters: NO_FILTERS }],
    ['tab=history&historyView=other', { mode: 'history', filters: NO_FILTERS }],
  ])('?%s → %j', (query, address) => {
    expect(read(query)).toEqual(address)
  })

  it.each([
    'loanId=loan-7',
    'loanId=loan-7&role=borrower',
    'loanId=loan-7&tab=history',
    'loanId=loan-7&q=Дюна&status=LOST',
  ])('?%s відкриває одне позичання: loanId важливіший за вкладку й фільтри', (query) => {
    expect(read(query)).toEqual({ mode: 'loan', loanId: 'loan-7' })
  })

  it('вкладка адреси: бік для поточних, history для історії', () => {
    expect(tabOf({ mode: 'list', side: 'borrower', filters: NO_FILTERS })).toBe('borrower')
    expect(tabOf({ mode: 'list', side: 'all', filters: NO_FILTERS })).toBe('all')
    expect(tabOf({ mode: 'history', filters: NO_FILTERS })).toBe('history')
  })

  describe('пошук і статус в адресі', () => {
    it('пошук береться як є, у будь-якій вкладці', () => {
      expect(read('q=%20Орвелл')).toEqual({
        mode: 'list',
        side: 'all',
        filters: { query: ' Орвелл', status: null },
      })
      expect(read('tab=history&q=Дюна')).toEqual({
        mode: 'history',
        filters: { query: 'Дюна', status: null },
      })
    })

    it('поточні вкладки фільтруються лише за відкритими статусами й простроченням', () => {
      expect(statusFiltersOf('all')).toEqual([
        'REQUESTED',
        'APPROVED',
        'HANDED_OVER',
        'PENDING_CONFIRMATION',
        'OVERDUE',
      ])
      expect(read('role=owner&status=OVERDUE')).toEqual({
        mode: 'list',
        side: 'owner',
        filters: { query: '', status: 'OVERDUE' },
      })
    })

    it('«Історія» фільтрується лише за статусами, що завершують позику', () => {
      expect(statusFiltersOf('history')).toEqual([
        'REJECTED',
        'CANCELLED',
        'RETURNED',
        'LOST',
        'DECLINED',
      ])
      expect(read('tab=history&status=LOST')).toEqual({
        mode: 'history',
        filters: { query: '', status: 'LOST' },
      })
    })

    it.each([
      ['status=RETURNED', 'list'],
      ['status=returned', 'list'],
      ['tab=history&status=HANDED_OVER', 'history'],
      ['tab=history&status=OVERDUE', 'history'],
    ])('?%s — статус, якого вкладка не показує, не фільтрує', (query, mode) => {
      expect(read(query)).toMatchObject({ mode, filters: NO_FILTERS })
    })
  })

  describe('loansTabHref', () => {
    it('«Історія» ставить tab=history і зберігає пошук та сторонні параметри', () => {
      expect(loansTabHref(new URLSearchParams('q=Дюна&role=borrower&x=1'), 'history')).toBe(
        '/loans?q=%D0%94%D1%8E%D0%BD%D0%B0&role=borrower&x=1&tab=history',
      )
    })

    it.each(['owner', 'borrower'] as const)(
      '«%s» прибирає tab і ставить role, решта параметрів лишається',
      (role) => {
        expect(loansTabHref(new URLSearchParams('tab=history&historyView=lent&x=1'), role)).toBe(
          `/loans?historyView=lent&x=1&role=${role}`,
        )
      },
    )

    it('«Усі» прибирає і tab, і role', () => {
      expect(loansTabHref(new URLSearchParams('tab=history&role=owner'), 'all')).toBe('/loans')
    })

    it('статус лишається між поточними вкладками й зникає там, де його не буває', () => {
      const current = new URLSearchParams('role=owner&status=OVERDUE')

      expect(loansTabHref(current, 'borrower')).toBe('/loans?role=borrower&status=OVERDUE')
      expect(loansTabHref(current, 'history')).toBe('/loans?role=owner&tab=history')
      expect(loansTabHref(new URLSearchParams('tab=history&status=LOST'), 'all')).toBe('/loans')
    })

    it('без параметрів — лише сама вкладка', () => {
      expect(loansTabHref(new URLSearchParams(), 'borrower')).toBe('/loans?role=borrower')
      expect(loansTabHref(new URLSearchParams(), 'history')).toBe('/loans?tab=history')
      expect(loansTabHref(new URLSearchParams(), 'all')).toBe('/loans')
    })

    it('кожна побудована адреса читається назад у ту саму вкладку', () => {
      for (const tab of LOANS_TABS) {
        const address = readLoansAddress(
          new URL(loansTabHref(new URLSearchParams('role=nobody&x=1'), tab), 'http://local')
            .searchParams,
        )

        expect(address.mode === 'loan' ? undefined : tabOf(address)).toBe(tab)
      }
    })
  })

  describe('loansFiltersHref', () => {
    it('ставить пошук і статус, не чіпаючи вкладку', () => {
      expect(loansFiltersHref(new URLSearchParams('role=owner'), { query: 'Дюна' })).toBe(
        '/loans?role=owner&q=%D0%94%D1%8E%D0%BD%D0%B0',
      )
      expect(loansFiltersHref(new URLSearchParams('tab=history'), { status: 'LOST' })).toBe(
        '/loans?tab=history&status=LOST',
      )
    })

    it('порожній пошук і null-статус прибираються з адреси; вкладка лишається', () => {
      expect(
        loansFiltersHref(new URLSearchParams('role=owner&q=x&status=APPROVED'), {
          query: '  ',
          status: null,
        }),
      ).toBe('/loans?role=owner')
      expect(loansFiltersHref(new URLSearchParams('q=x'), { query: '' })).toBe('/loans')
    })
  })

  describe('loanHref і loansBackHref: позика зі списку й дорога назад', () => {
    const searchOf = (href: string) => new URL(href, 'http://local').searchParams

    it('позика зберігає вкладку, пошук, статус і сторонні параметри списку', () => {
      expect(
        loanHref(new URLSearchParams('role=owner&q=Дюна&status=APPROVED&x=1'), 'owner', 'l-1'),
      ).toBe('/loans?role=owner&q=%D0%94%D1%8E%D0%BD%D0%B0&status=APPROVED&x=1&loanId=l-1')
      expect(loanHref(new URLSearchParams('tab=history'), 'history', 'l-1')).toBe(
        '/loans?tab=history&loanId=l-1',
      )
    })

    it('«Усі» записано явно (tab=all) і читається як «Усі»', () => {
      expect(loanHref(new URLSearchParams(), 'all', 'l-1')).toBe('/loans?tab=all&loanId=l-1')
      expect(read('tab=all')).toEqual({ mode: 'list', side: 'all', filters: NO_FILTERS })
    })

    it.each(LOANS_TABS)('зі списку «%s» loanId важливіший за решту параметрів', (tab) => {
      const href = loanHref(new URLSearchParams('q=Дюна&status=LOST&role=owner'), tab, 'loan-7')

      expect(readLoansAddress(searchOf(href))).toEqual({ mode: 'loan', loanId: 'loan-7' })
    })

    it.each(LOANS_TABS)(
      '«← Позичання» повертає ту саму вкладку «%s» з пошуком і статусом',
      (tab) => {
        const list = new URLSearchParams(
          searchOf(
            loansFiltersHref(searchOf(loansTabHref(new URLSearchParams(), tab)), { query: 'Дюна' }),
          ),
        )
        const role = tab === 'borrower' ? 'borrower' : 'owner'
        const back = loansBackHref(searchOf(loanHref(list, tab, 'loan-7')), role, role)
        const address = readLoansAddress(searchOf(back))

        expect(back).not.toContain('loanId')
        expect(address.mode === 'loan' ? undefined : tabOf(address)).toBe(tab)
        expect(address).toMatchObject({ filters: { query: 'Дюна' } })
      },
    )

    it('пряме посилання без списку веде на вкладку, де ця позика є', () => {
      expect(loansBackHref(new URLSearchParams('loanId=loan-7'), 'borrower', 'borrower')).toBe(
        '/loans?role=borrower',
      )
      expect(loansBackHref(new URLSearchParams('loanId=loan-7'), 'owner', 'history')).toBe(
        '/loans?tab=history',
      )
      expect(loansBackHref(new URLSearchParams('loanId=loan-7'), null, 'all')).toBe('/loans')
    })

    it('?role= з адреси, що не збігається з боком позики, не веде в чужий список', () => {
      expect(
        loansBackHref(new URLSearchParams('loanId=loan-7&role=owner&q=x'), 'borrower', 'borrower'),
      ).toBe('/loans?role=borrower&q=x')
      expect(loansBackHref(new URLSearchParams('loanId=loan-7&role=owner'), null, 'all')).toBe(
        '/loans',
      )
    })
  })
})
