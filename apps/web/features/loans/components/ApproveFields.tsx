'use client'

import type { Loan } from '@bookswap/shared'
import { TextField } from '@/components/Form/FormFields'
import type { ApproveFormState } from '../model/use-approve-form'

/**
 * The approval's fields, the same on the loan's page and on the home page (BS-147). §8: `dueAt` is
 * accepted only together with `approve` — the owner sets the term while approving the request.
 */
export function ApproveFields({ loan, form }: { loan: Loan; form: ApproveFormState }) {
  return (
    <>
      <TextField
        id={`due-${loan.id}`}
        label="Повернути до"
        type="date"
        hint={loan.dueAt === null ? undefined : 'Позичальник просив саме цю дату.'}
        value={form.dueAt}
        onChange={(event) => {
          form.setDueAt(event.target.value)
        }}
      />
      <TextField
        id={`note-${loan.id}`}
        label="Відповідь"
        autoComplete="off"
        value={form.note}
        onChange={(event) => {
          form.setNote(event.target.value)
        }}
      />
    </>
  )
}
