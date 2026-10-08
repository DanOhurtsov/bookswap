/** Tailwind-еквіваленти спільних класів сторінки додавання (`.page`, `.lede`, `.books`, `.status--pending`, `.empty`). */
export const pageClass = 'mx-auto max-w-2xl px-6 py-16 max-[30rem]:px-4 max-[30rem]:py-8'

export const ledeClass = 'mb-8 text-[color:var(--bookswap-muted)]'

export const booksClass = 'mb-6 grid list-none gap-3 p-0'

export const pendingStatusClass =
  'm-0 rounded-md border border-current px-4 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'

/** The "still searching" line: plain muted text, no frame. */
export const searchingStatusClass =
  'm-0 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'

export const emptyClass =
  'm-0 rounded-md border border-dashed border-[color:var(--line)] px-4 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'
