import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Stage 10 (T4, R7): `LoanEvent` append-only на рівні коду. Тригера в БД немає свідомо; замість
 * нього цей тест гарантує, що в `src` (крім згенерованого клієнта) немає жодного виклику, який
 * змінює чи видаляє події, — лише `create`/читання.
 */
const SRC = join(__dirname, '..')
const MUTATIONS = /loanEvent\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b/
const RAW_MUTATIONS = /(UPDATE|DELETE\s+FROM|TRUNCATE)\s+"?LoanEvent"?/i

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)

    if (name === 'generated') return []
    if (statSync(path).isDirectory()) return sources(path)

    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : []
  })
}

describe('LoanEvent append-only (код)', () => {
  it('у src немає update/upsert/delete для LoanEvent — ні через клієнт, ні сирим SQL', () => {
    const offenders = sources(SRC).filter((file) => {
      const text = readFileSync(file, 'utf8')

      return MUTATIONS.test(text) || RAW_MUTATIONS.test(text)
    })

    expect(offenders).toEqual([])
  })

  it('єдиний запис — LoanEventService.record (create)', () => {
    const writers = sources(SRC).filter((file) =>
      /loanEvent\s*\.\s*(create|createMany)\b/.test(readFileSync(file, 'utf8')),
    )

    expect(writers.map((file) => file.slice(SRC.length + 1))).toEqual([
      join('loans', 'loan-event.service.ts'),
    ])
  })
})
