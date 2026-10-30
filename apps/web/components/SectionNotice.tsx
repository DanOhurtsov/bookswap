import type { LucideIcon } from 'lucide-react'
import type { AriaRole, ReactNode } from 'react'

/**
 * BS-147: what a home page section says instead of its content — nothing to show yet, or a read that
 * failed (canvas «Main Page», empty sections): a compact row with an icon, a title, an optional line
 * of text and an optional action on the right, never a large empty card. The section keeps its own
 * heading above it. Without a `.canvas-theme` page around it, it falls back to the app's tokens.
 */
export function SectionNotice({
  icon: Icon,
  title,
  text,
  action,
  role,
}: {
  icon: LucideIcon
  title: ReactNode
  text?: ReactNode
  /** A link or a button; a link takes `SECTION_NOTICE_LINK` for the canvas look. */
  action?: ReactNode
  /** `alert` for a failure the reader must hear about. */
  role?: AriaRole
}) {
  return (
    <div className="section-notice" role={role}>
      <span className="section-notice__icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="section-notice__body">
        <p className="section-notice__title">{title}</p>
        {text !== undefined && <p className="section-notice__text">{text}</p>}
      </div>
      {action}
    </div>
  )
}

/** The class of a link in a `SectionNotice` action: the accent, 15 px semibold, a 44 px target. */
export const SECTION_NOTICE_LINK = 'section-notice__link'
