// Same tiny helpers as `features/catalog/add-book/model/form-values.ts` — not
// imported from there: a feature only exposes its `index.client.ts`, and
// these two lines are cheaper to repeat than to promote to a shared package.
export function nullableText(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? null : value
}

export function nullableNumber(value: unknown): unknown {
  return value === '' || value === null || value === undefined ? null : Number(value)
}
