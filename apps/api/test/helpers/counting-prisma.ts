/**
 * Counts the database statements one request issues, by name.
 *
 * R7's promise is that resolution does not grow by a query per row, and the
 * only way to hold that promise is to measure it. Wrapping the injected
 * `PrismaService` in a proxy counts what the application actually calls —
 * models, raw queries and the clients handed out inside `$transaction` alike —
 * without turning on Prisma query logging in production code, where it would
 * write user data into the logs (§9.3).
 */

/** `model.operation`, e.g. `edition.findMany` or `$queryRaw`. */
export type QueryLog = string[]

const RAW_METHODS = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'])

function isModelDelegate(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'findMany' in value
}

function countDelegate(name: string, delegate: object, log: QueryLog): object {
  return new Proxy(delegate, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown

      if (typeof value !== 'function' || typeof property !== 'string') return value

      return (...args: unknown[]): unknown => {
        log.push(`${name}.${property}`)

        return (value as (...call: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

/**
 * The proxy is transparent: every call is forwarded to the real client, so the
 * test exercises the real queries and merely watches them go by.
 */
export function countingPrisma<T extends object>(client: T, log: QueryLog): T {
  return new Proxy(client, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown

      if (typeof property !== 'string') return value

      if (RAW_METHODS.has(property) && typeof value === 'function') {
        return (...args: unknown[]): unknown => {
          log.push(property)

          return (value as (...call: unknown[]) => unknown).apply(target, args)
        }
      }

      if (property === '$transaction' && typeof value === 'function') {
        return (first: unknown, ...rest: unknown[]): unknown => {
          const wrapped =
            typeof first === 'function'
              ? (tx: object) => (first as (client: object) => unknown)(countingPrisma(tx, log))
              : first

          return (value as (...call: unknown[]) => unknown).apply(target, [wrapped, ...rest])
        }
      }

      if (isModelDelegate(value)) return countDelegate(property, value as object, log)

      return value
    },
  })
}

/** Statements that ran during `run`, in order. */
export async function recordQueries(log: QueryLog, run: () => Promise<void>): Promise<QueryLog> {
  const before = log.length

  await run()

  return log.slice(before)
}
