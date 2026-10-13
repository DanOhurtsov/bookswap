// `nullableText`/`nullableNumber`: the same tiny helpers as
// `features/catalog/add-book/model/form-values.ts` — not imported from there:
// a feature only exposes its `index.client.ts`, and these two lines are
// cheaper to repeat than to promote to a shared package.
export function nullableText(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value
}

export function nullableNumber(value: unknown): unknown {
  return value === '' || value === null || value === undefined ? null : Number(value)
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Structural equality for form values — plain JSON data. Object key order is
 * NOT significant (the same author can be built as `{ name, role, nameLatin }`
 * by the row editor and `{ name, nameLatin, role }` by zod); array order IS
 * (it is the authors' order). A key holding `undefined` equals a missing key,
 * as in JSON; `null` does not.
 */
export function plainDataEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true

  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => plainDataEqual(item, b[index]))
    )
  }

  if (!isObjectLike(a) || !isObjectLike(b)) return false

  const keys = new Set([...Object.keys(a), ...Object.keys(b)])

  return [...keys].every((key) => plainDataEqual(a[key], b[key]))
}

/**
 * An independent deep copy of a form value. Form values here are plain JSON
 * data — strings, numbers, booleans, `null`, arrays and plain objects — so a
 * JSON round trip is exact for them. Not `structuredClone`: jest's jsdom
 * environment does not provide it.
 */
export function copyFormValue<T>(value: T): T {
  if (value === undefined) return value

  const copy: unknown = JSON.parse(JSON.stringify(value))

  // Same JSON data as `value`, just a different identity — the round trip
  // cannot change its type for plain JSON data.
  return copy as T
}
