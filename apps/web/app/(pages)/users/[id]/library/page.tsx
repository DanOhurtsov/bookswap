import { LegacyPersonRedirect } from '@/features/library/person-library/index.client'

/**
 * §1.1: reads the route param and composes. The address before BS-148: it now only sends the viewer
 * on to `/u/<handle>` (`LegacyPersonRedirect`).
 */
export default async function LegacyPersonLibraryPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params

  return <LegacyPersonRedirect userId={id} />
}
