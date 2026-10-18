/**
 * Tailwind equivalents of the global classes the add-book screens use (`.lede`, `.status--pending`,
 * `.empty`). The page box is not copied here: the screens use `.page` itself (BS-133); the result list is
 * the shared `ResultCardGrid` (BS-134).
 */

export const ledeClass = 'mb-8 text-[color:var(--bookswap-muted)]'

export const pendingStatusClass =
  'm-0 rounded-md border border-current px-4 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'

/** The "still searching" line: plain muted text, no frame. */
export const searchingStatusClass =
  'm-0 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'

export const emptyClass =
  'm-0 rounded-md border border-dashed border-[color:var(--line)] px-4 py-[0.85rem] text-[0.95rem] text-[color:var(--bookswap-muted)]'

/** A link that leads to the next step, drawn like the global `button` / `.button--ghost` beside it. */
export const actionLinkClass =
  'inline-flex items-center rounded-[0.4rem] border px-[1.1rem] py-[0.65rem] font-semibold no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--bookswap-accent)'

export const primaryLinkClass = `${actionLinkClass} border-transparent bg-(--fg) text-(--bg)`

export const ghostLinkClass = `${actionLinkClass} border-(--line) text-(--fg)`

/**
 * A secondary `<button>` with `data-ui="button"`: `.button--ghost` loses to the global
 * `button:not([data-ui='button'])` rule (higher specificity), so the opt-out draws it here instead.
 */
export const ghostButtonClass = `${ghostLinkClass} cursor-pointer bg-transparent`
