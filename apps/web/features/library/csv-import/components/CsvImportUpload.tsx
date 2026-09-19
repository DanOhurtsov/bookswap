'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { LIBRARY_IMPORT_LIMITS, LIBRARY_IMPORT_XLSX_LIMITS } from '@bookswap/shared'
import { FormStatus } from '@/components/Form/FormStatus'
import { formatKib } from '../model/import-draft-state'
import { IMPORT_FILE_ACCEPT } from '../model/import-file'
import { useLibraryImportUpload } from '../model/use-library-import-upload'
import { ImportFailureNotice } from './ImportFailureNotice'

const CSV_TEMPLATE_PATH = '/library-import-template.csv'
const XLSX_TEMPLATE_PATH = '/library-import-template.xlsx'

/**
 * Stage 8f-3, extended for `.xlsx` in 8f-4: the entry point into an import.
 *
 * The limits are read from the shared constants, never retyped: a second copy
 * of "48 KiB" here would go stale the first time the contract moves, and the
 * person would be told a rule the server no longer enforces. The two formats
 * have different size caps for a real reason — a workbook is a compressed
 * archive — so both are named rather than averaged into one number.
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
            Завантажте шаблон — <Link href={XLSX_TEMPLATE_PATH}>Excel (.xlsx)</Link> або{' '}
            <Link href={CSV_TEMPLATE_PATH}>CSV</Link> — і заповніть його своїми книжками.
          </li>
          <li>Надішліть файл — ми покажемо, що саме буде додано, ще до імпорту.</li>
          <li>Виправте або пропустіть рядки, з якими є питання.</li>
        </ol>

        <h2 className="import-intro__title">Обмеження файла</h2>
        <ul className="import-intro__limits">
          <li>
            Розмір — до {formatKib(LIBRARY_IMPORT_LIMITS.maxBytes)} для CSV і до{' '}
            {formatKib(LIBRARY_IMPORT_XLSX_LIMITS.maxBytes)} для .xlsx.
          </li>
          <li>До {LIBRARY_IMPORT_LIMITS.maxDataRows} рядків із книжками.</li>
          <li>Разом — не більше {LIBRARY_IMPORT_LIMITS.maxCopies} примірників.</li>
          <li>
            Кількість в одному рядку — від {LIBRARY_IMPORT_LIMITS.quantityMin} до{' '}
            {LIBRARY_IMPORT_LIMITS.quantityMax}.
          </li>
          <li>ISBN-13 обовʼязковий у кожному рядку. Решту колонок можна лишити порожніми.</li>
          <li>Колонки та їхній порядок — точно як у шаблоні; для CSV кодування UTF-8.</li>
          <li>
            У книзі Excel — один аркуш із даними, без формул. Формати .xls, .xlsm і файли під
            паролем не підтримуємо.
          </li>
        </ul>
      </section>

      <div className="field">
        <label htmlFor="import-file">Файл CSV або Excel</label>
        <input
          id="import-file"
          type="file"
          accept={IMPORT_FILE_ACCEPT}
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
