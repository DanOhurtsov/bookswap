import { readFileSync } from 'node:fs'
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

const GENERAL_SURFACES = [
  'apps/web/app/lib/use-loans.ts',
  'apps/web/app/lib/use-history.ts',
  'apps/web/app/(pages)/loans/page.tsx',
  'apps/web/app/(pages)/history/page.tsx',
  'apps/web/components/HistoryEntryLine.tsx',
]

describe('приватність alias гостьового контакту (Stage 10, 10f.3)', () => {
  it.each(GENERAL_SURFACES)('%s не згадує гостьовий контакт/alias', (path) => {
    const source = read(path)

    expect(source).not.toMatch(/\bGuestLoan\b/)
    expect(source).not.toMatch(/\bcontact\b/i)
    expect(source).not.toContain('alias')
  })

  it('лише owner-only гостьовий екран показує alias', () => {
    const source = read('apps/web/features/guest-loans/components/GuestLoansScreen.tsx')

    expect(source).toContain('contact.alias')
  })
})
