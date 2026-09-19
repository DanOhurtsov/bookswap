'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { LIBRARY_IMPORT_LIMITS } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { formatKib } from '../model/import-draft-state'
import { useLibraryImportUpload } from '../model/use-library-import-upload'
import { ImportFailureNotice } from './ImportFailureNotice'

const TEMPLATE_PATH = '/library-import-template.csv'

/**
 * Stage 8f-3: the entry point into a CSV import.
 *
 * The limits are read from the shared constants, never retyped: a second copy
 * of "48 KiB" here would go stale the first time the contract moves, and the
 * person would be told a rule the server no longer enforces.
 */
export function CsvImportUpload() {
  const upload = useLibraryImportUpload()
  const [file, setFile] = useState<File | null>(null)

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()

    if (file === null) return

    upload.upload(file)
  }

  return (
    <form className="form" onSubmit={submit} noValidate>
      <section className="import-intro">
        <h2 className="import-intro__title">Як це працює</h2>
        <ol className="import-intro__steps">
          <li>
            Завантажте <Link href={TEMPLATE_PATH}>шаблон CSV</Link> і заповніть його своїми
            книжками.
          </li>
          <li>Надішліть файл — ми покажемо, що саме буде додано, ще до імпорту.</li>
          <li>Виправте або пропустіть рядки, з якими є питання.</li>
        </ol>

        <h2 className="import-intro__title">Обмеження файла</h2>
        <ul className="import-intro__limits">
          <li>Розмір — до {formatKib(LIBRARY_IMPORT_LIMITS.maxBytes)}.</li>
          <li>До {LIBRARY_IMPORT_LIMITS.maxDataRows} рядків із книжками.</li>
          <li>Разом — не більше {LIBRARY_IMPORT_LIMITS.maxCopies} примірників.</li>
          <li>
            Кількість в одному рядку — від {LIBRARY_IMPORT_LIMITS.quantityMin} до{' '}
            {LIBRARY_IMPORT_LIMITS.quantityMax}.
          </li>
          <li>ISBN-13 обовʼязковий у кожному рядку. Решту колонок можна лишити порожніми.</li>
          <li>Кодування — UTF-8; колонки та їхній порядок — точно як у шаблоні.</li>
        </ul>
      </section>

      <div className="field">
        <label htmlFor="import-file">Файл CSV</label>
        <input
          id="import-file"
          type="file"
          accept=".csv,text/csv"
          className="import-file"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null)
            upload.reset()
          }}
        />
      </div>

      {upload.localError !== undefined && <FormStatus error={new Error(upload.localError)} />}

      {upload.uploadFailure !== undefined && (
        <ImportFailureNotice
          failure={upload.uploadFailure}
          onRetry={() => {
            if (file !== null) upload.upload(file)
          }}
        />
      )}

      <div className="import-actions">
        <button
          type="submit"
          className="import-action"
          disabled={file === null || upload.isUploading}
        >
          {upload.isUploading ? 'Перевіряю файл…' : 'Перевірити файл'}
        </button>
      </div>

      <p className="form__aside">
        Нічого не буде додано до бібліотеки на цьому кроці — спершу ви побачите попередній перегляд.{' '}
        <Link href="/library">Моя бібліотека</Link>
      </p>
    </form>
  )
}
