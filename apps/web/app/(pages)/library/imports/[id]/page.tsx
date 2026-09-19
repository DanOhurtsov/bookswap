import { Suspense } from 'react'
import { CsvImportDraft } from '@/features/library/csv-import/index.client'

/**
 * §1.1: reads the route param, composes, and leaves the rest to the feature.
 *
 * `Suspense` because the draft screen keeps its row filter in the URL
 * (`useSearchParams`, §3.8) — the boundary is what lets the page render
 * statically around it instead of opting the whole route into dynamic
 * rendering.
 */
export default async function LibraryImportDraftPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return (
    <main className="page">
      <h1>Попередній перегляд імпорту</h1>
      <Suspense fallback={<p className="status status--pending">Завантажую чернетку…</p>}>
        <CsvImportDraft importId={id} />
      </Suspense>
    </main>
  )
}
