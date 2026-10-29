import { PersonScreen } from '@/features/library/person-library/index.client'

/**
 * §1.1: reads the route param and composes. BS-148: a person's address is their nickname,
 * LinkedIn-style; the guard, the lookup and the library live in `features/library/person-library`.
 * The param is passed as it came: a valid nickname never needs percent-encoding, so anything encoded
 * is «not found» either way.
 */
export default async function PersonPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  return <PersonScreen handle={handle} />
}
