import {
  LOANS_HISTORY_HREF,
  LOANS_TABS,
  historyViewHref,
  loansTabHref,
  readLoansAddress,
  tabOf,
} from './loans-address'

const read = (query: string) => readLoansAddress(new URLSearchParams(query))

describe('адреса розділу «Позичання» (BS-143)', () => {
  it('вкладки йдуть у погодженому порядку: «Мої книжки», «Я позичаю», «Історія»', () => {
    expect(LOANS_TABS).toEqual(['owner', 'borrower', 'history'])
    expect(LOANS_HISTORY_HREF).toBe('/loans?tab=history')
  })

  it.each([
    ['', { mode: 'list', role: 'owner' }],
    ['role=owner', { mode: 'list', role: 'owner' }],
    ['role=borrower', { mode: 'list', role: 'borrower' }],
    ['role=nobody', { mode: 'list', role: 'owner' }],
    ['tab=unknown&role=borrower', { mode: 'list', role: 'borrower' }],
    ['tab=HISTORY', { mode: 'list', role: 'owner' }],
    ['historyView=lent', { mode: 'list', role: 'owner' }],
    ['tab=history', { mode: 'history', view: 'borrowed' }],
    ['tab=history&role=borrower', { mode: 'history', view: 'borrowed' }],
    ['tab=history&historyView=borrowed', { mode: 'history', view: 'borrowed' }],
    ['tab=history&historyView=lent', { mode: 'history', view: 'lent' }],
    ['tab=history&historyView=other', { mode: 'history', view: 'borrowed' }],
  ])('?%s → %j', (query, address) => {
    expect(read(query)).toEqual(address)
  })

  it.each(['loanId=loan-7', 'loanId=loan-7&role=borrower', 'loanId=loan-7&tab=history'])(
    '?%s відкриває одне позичання: loanId важливіший за вибір вкладки',
    (query) => {
      expect(read(query)).toEqual({ mode: 'loan', loanId: 'loan-7' })
    },
  )

  it('вкладка адреси: роль для списку, history для історії', () => {
    expect(tabOf({ mode: 'list', role: 'borrower' })).toBe('borrower')
    expect(tabOf({ mode: 'history', view: 'lent' })).toBe('history')
  })

  describe('loansTabHref', () => {
    it('«Історія» ставить tab=history і зберігає решту параметрів', () => {
      expect(loansTabHref(new URLSearchParams('status=REQUESTED&role=borrower'), 'history')).toBe(
        '/loans?status=REQUESTED&role=borrower&tab=history',
      )
    })

    it.each(['owner', 'borrower'] as const)(
      '«%s» прибирає tab і ставить role, решта параметрів лишається',
      (role) => {
        expect(
          loansTabHref(new URLSearchParams('tab=history&historyView=lent&status=X'), role),
        ).toBe(`/loans?historyView=lent&status=X&role=${role}`)
      },
    )

    it('без параметрів — лише сама вкладка', () => {
      expect(loansTabHref(new URLSearchParams(), 'borrower')).toBe('/loans?role=borrower')
      expect(loansTabHref(new URLSearchParams(), 'history')).toBe('/loans?tab=history')
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

  describe('historyViewHref', () => {
    it.each(['borrowed', 'lent'] as const)(
      'ставить historyView=%s, лишає tab=history і решту параметрів',
      (view) => {
        expect(
          historyViewHref(new URLSearchParams('tab=history&role=owner&historyView=x'), view),
        ).toBe(`/loans?tab=history&role=owner&historyView=${view}`)
      },
    )

    it('читається назад у ту саму підвкладку', () => {
      expect(
        readLoansAddress(
          new URL(historyViewHref(new URLSearchParams(), 'lent'), 'http://local').searchParams,
        ),
      ).toEqual({ mode: 'history', view: 'lent' })
    })
  })
})
