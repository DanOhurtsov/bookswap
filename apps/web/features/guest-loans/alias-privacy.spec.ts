import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stage 10 (10f.3, item 5 web-рев'ю, D4/P1/P2): гостьовий alias і сам факт «контакт» — це поле,
 * яке віддає ЛИШЕ `GET /loans/guest[/:id]` (owner-only). Жодна загальна поверхня — список
 * зареєстрованих позик, картки історії, публічні/аналітичні компоненти — не повинна знати про
 * `contact`/`alias`: якщо колись хтось випадково імпортує `GuestLoan` у ці файли чи скопіює туди
 * рядок `гість:`, цей тест провалиться раніше, ніж alias дійсно кудись протече.
 *
 * Джерело перевіряється текстом (як-от `page.server.spec.tsx` для `/library`) — не через рендер,
 * бо мета саме «цього рядка коду там немає», а не «поточний пропс його не показує».
 */
const root = join(__dirname, '../../../..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

// BS-143: the loans and history screens moved from their route files into `features/loans`; the
// routes are now thin wrappers, so the screens are checked where they actually live. Every source
// file of that feature is a general surface — a new one is covered without editing this list.
const LOANS_FEATURE = 'apps/web/features/loans'

const GENERAL_SURFACES = [
  'apps/web/app/lib/use-loans.ts',
  'apps/web/app/lib/use-history.ts',
  'apps/web/app/(pages)/loans/page.tsx',
  'apps/web/app/(pages)/history/page.tsx',
  'apps/web/components/HistoryEntryLine.tsx',
  ...sourcesOf(LOANS_FEATURE),
]

function sourcesOf(directory: string): string[] {
  return readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.tsx?$/.test(path) && !/\.spec\.tsx?$/.test(path))
    .map((path) => `${directory}/${path}`)
    .sort()
}

describe('приватність alias гостьового контакту (Stage 10, 10f.3)', () => {
  it.each(GENERAL_SURFACES)('%s не згадує гостьовий контакт/alias', (path) => {
    const source = read(path)

    expect(source).not.toMatch(/\bGuestLoan\b/)
    expect(source).not.toMatch(/\bcontact\b/i)
    expect(source).not.toContain('alias')
  })

  it('перенесені екрани позичань та історії справді перевіряються, а не лише route wrappers', () => {
    expect(GENERAL_SURFACES).toEqual(
      expect.arrayContaining([
        `${LOANS_FEATURE}/components/LoansScreen.tsx`,
        `${LOANS_FEATURE}/components/LoanListPanel.tsx`,
        `${LOANS_FEATURE}/components/LoanCard.tsx`,
        `${LOANS_FEATURE}/components/LoanCardActions.tsx`,
        `${LOANS_FEATURE}/components/SingleLoanView.tsx`,
        `${LOANS_FEATURE}/components/LoansHistoryPanel.tsx`,
        `${LOANS_FEATURE}/model/loans-address.ts`,
      ]),
    )
  })

  it('лише owner-only гостьовий екран показує alias', () => {
    const source = read('apps/web/features/guest-loans/components/GuestLoansScreen.tsx')

    expect(source).toContain('contact.alias')
  })
})

/**
 * Stage 10 (10i.3): публічна сторінка гостя не знає ні про сесію власника, ні про контакт/alias/дату
 * передачі, ні про сховища браузера: токен лише в пам'яті, до перевірки email — лише назва, автори, строк.
 */
describe('публічна сторінка гостя (Stage 10, 10i.3)', () => {
  const source = () =>
    read('apps/web/features/guest-loans/components/GuestLoanResponse.tsx') +
    read('apps/web/features/guest-loans/model/guest-link-token.ts')

  it.each([
    'handedAt',
    'alias',
    'contact',
    'useSession',
    'sessionStorage',
    'localStorage',
    'guestEmail',
    'guestNickname',
  ])('не згадує %s', (word) => {
    expect(source()).not.toContain(word)
  })

  it('прибирає токен з адреси й шле його лише в тілі запиту', () => {
    expect(source()).toContain('history.replaceState')
    expect(read('apps/web/features/guest-loans/api/guest-confirmation-requests.ts')).toMatch(
      /guest-loan-responses\/resolve[\s\S]*body: \{ token \}/,
    )
  })
})
