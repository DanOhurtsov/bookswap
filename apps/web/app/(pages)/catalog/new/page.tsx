import { Suspense } from 'react'
import { AddBookScreen } from '@/features/catalog/add-book/index.client'

export default function NewBookPage() {
  return (
    <Suspense
      fallback={
        <main className="page">
          <h1>Додати книжку</h1>
          <p className="status status--pending">Читаю запит…</p>
        </main>
      }
    >
      <AddBookScreen />
    </Suspense>
  )
}
