import type { PrismaService } from '../src/prisma/prisma.service'
import type request from 'supertest'

/** Обіцянка, якою керує тест: жодних `sleep`, лише явні сигнали. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })

  return { promise, resolve }
}

/** Гейт «увійшов у критичну секцію» / «тест дозволив вийти». */
export interface Gate {
  entered: ReturnType<typeof deferred>
  release: ReturnType<typeof deferred>
}

export function gate(): Gate {
  return { entered: deferred(), release: deferred() }
}

/**
 * Чекає, доки в `pg_stat_activity` з'явиться інше з'єднання, яке справді
 * заблоковане на PostgreSQL-локу (`wait_event_type = 'Lock'`).
 *
 * Це не `sleep` для «наздогнати таймінг»: це опитування РЕАЛЬНОГО стану бази
 * до виконання конкретної, наперед відомої умови — стандартний прийом для
 * детермінованих тестів на блокування рядків. Без нього тест, який просто
 * «стартує другий запит і одразу звільняє гейт», міг би випадково не встигнути
 * створити справжню контенцію (друга транзакція ще не дійшла до `FOR UPDATE`,
 * коли перша вже закомітилася) — і мовчки перестати перевіряти те, що обіцяє.
 *
 * Блокування самого гейта (тест паузить код усередині відкритої транзакції
 * через `await` на JS-проміс) під це визначення НЕ підпадає: з'єднання, що
 * чекає на JS, для PostgreSQL виглядає як «ідле в транзакції», а не як
 * «wait_event_type = Lock» — тож ця функція жодного разу не спрацює хибно на
 * власному гейті виклику, який ми самі тримаємо.
 */
export async function waitForBlockedBackend(
  prisma: PrismaService,
  options: { expectedCount?: number; timeoutMs?: number } = {},
): Promise<void> {
  const { expectedCount = 1, timeoutMs = 5000 } = options
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND state = 'active'
    `

    if (Number(rows[0]?.count ?? 0n) >= expectedCount) return

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(
    `За ${String(timeoutMs)} мс на локу не заблокувалося ${String(expectedCount)} з'єднань — тест не довів заявлену контенцію`,
  )
}

/**
 * Гарантовано запускає supertest-запит негайно, замість того щоб покладатися
 * на те, коли саме щось уперше зверне увагу на `.then()`.
 *
 * `supertest.Test` успадковує `superagent.Request`, який не надсилає запит на
 * самій конструкції — лише коли щось викликає `.end()` (напряму або через
 * thenable). У бар'єрних тестах нам треба РІВНО знати момент, коли запит уже
 * пішов у мережу (щоб далі чесно чекати на реальний лок у `pg_stat_activity`),
 * а не сподіватися, що виклик у виразі без `await` це вже зробив.
 */
export function beginRequest(test: request.Test): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    test.end((err, res) => {
      if (err !== null && err !== undefined)
        reject(err instanceof Error ? err : new Error(String(err)))
      else resolve(res)
    })
  })
}

/**
 * A rendezvous point for N operations that must all reach the same place before
 * any of them continues.
 *
 * `waitForBlockedBackend` proves contention on a PostgreSQL lock; this proves it
 * where there is no lock to wait on. The two imports racing to insert the same
 * ISBN share nothing before the insert, so nothing queues them: without a
 * barrier the loser usually just reads the winner's row in its precheck, and the
 * unique index — the thing the test claims to exercise — is never touched.
 *
 * `ready` is bounded: if a participant never arrives, the test fails saying so
 * instead of hanging until Jest's own timeout, which says nothing about why.
 */
export interface Barrier {
  /** Resolves once every participant has arrived. Rejects if they do not, in time. */
  ready: Promise<void>
  /** Lets every arrived participant continue. Safe to call more than once. */
  release: () => void
  /** Called by the participants themselves; resolves when `release()` is called. */
  arrive: () => Promise<void>
}

export function barrier(participants: number, timeoutMs = 10_000): Barrier {
  let arrived = 0
  const allArrived = deferred()
  const released = deferred()
  let expire = (): void => undefined

  const ready = new Promise<void>((resolve, reject) => {
    // Declared before the timer that uses it, so there is no order to get wrong.
    expire = () => {
      reject(
        new Error(
          `Бар'єр не зібрав ${String(participants)} учасників за ${String(timeoutMs)} мс ` +
            `(прийшло ${String(arrived)}) — тест не довів заявлену одночасність`,
        ),
      )
    }
    void allArrived.promise.then(resolve)
  })
  const timer = setTimeout(() => {
    expire()
  }, timeoutMs)

  // Nothing here should keep the process alive on its own.
  timer.unref()

  return {
    ready,
    release: () => {
      clearTimeout(timer)
      released.resolve()
    },
    arrive: async () => {
      arrived += 1

      if (arrived >= participants) allArrived.resolve()

      await released.promise
    },
  }
}
