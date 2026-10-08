import { OwnBookScreen } from '@/features/library/own-book/index.client'

/**
 * §1.1: reads the route param and composes. The owner's page of one copy; `entryId` is the id of
 * the `Copy`, never of the edition or the work — an owner can hold several copies of one book.
 */
export default async function OwnBookPage({ params }: { params: Promise<{ entryId: string }> }) {
  const { entryId } = await params

  return <OwnBookScreen entryId={entryId} />
}
