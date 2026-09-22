import { fetchActivationProgress } from '@/features/library/activation'
import { ActivationChecklist } from '@/features/library/activation/index.client'
import { LibraryScreen } from '@/features/library/own-library/index.client'

/**
 * §1.1 and §2.2: the route reads, composes and nothing else.
 *
 * Stage 8h-2 (R11) makes this the one genuinely server-first screen in the
 * application: the activation count is read here, before anything is sent, so
 * the checklist is on the first paint rather than after a round trip. The
 * shelf below it stays exactly as it was — a client component with its own
 * legacy reader (R12) — and the checklist is handed to it as an element, so
 * neither one has to know how the other loads.
 *
 * `fetchActivationProgress` never throws: a failed or unauthorized read comes
 * back as a state the checklist renders, so the library itself is still here
 * when the activation endpoint is not.
 */
export default async function LibraryPage() {
  const activation = await fetchActivationProgress()

  return <LibraryScreen checklist={<ActivationChecklist initial={activation} />} />
}
