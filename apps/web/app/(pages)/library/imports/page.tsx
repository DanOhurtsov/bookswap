import Link from 'next/link'
import { CsvImportUpload } from '@/features/library/csv-import/index.client'

/**
 * §1.1/§2.2: the route composes and nothing more — the interactive half lives
 * in the feature's own client leaf.
 */
export default function LibraryImportPage() {
  return (
    <main className="page">
      <h1>Імпорт книжок із CSV</h1>
      <p className="lede">
        Надішліть файл — і перегляньте, що саме буде додано, перш ніж щось зміниться в{' '}
        <Link href="/library">бібліотеці</Link>.
      </p>
      <CsvImportUpload />
    </main>
  )
}
