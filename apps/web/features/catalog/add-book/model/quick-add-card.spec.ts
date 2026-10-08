import type { QuickAddTarget } from '@bookswap/shared'
import { quickAddCardProps } from './quick-add-card'
import type { QuickAddSlot } from './quick-add-slots'
import type { QuickAddApi } from './use-quick-add'

const identities = ['edition:e-1', 'isbn:9783161484100']
const target: QuickAddTarget = { kind: 'EXISTING_EDITION', editionId: 'e-1' }

function fakeQuick(slot?: QuickAddSlot) {
  return {
    slotFor: jest.fn<QuickAddSlot | undefined, [readonly string[]]>(() => slot),
    add: jest.fn<void, Parameters<QuickAddApi['add']>>(),
    retry: jest.fn<void, [readonly string[]]>(),
  } satisfies QuickAddApi
}

describe('quickAddCardProps', () => {
  it('reads the slot of exactly these identities', () => {
    const quick = fakeQuick()

    quickAddCardProps(quick, 'MANUAL', identities, target)

    expect(quick.slotFor).toHaveBeenCalledWith(identities)
  })

  it('hands the slot through unchanged', () => {
    const slot: QuickAddSlot = { status: 'done', added: 1, copyId: 'c-1', editionId: 'e-1' }
    const quick = fakeQuick(slot)

    expect(quickAddCardProps(quick, 'MANUAL', identities, target).slot).toBe(slot)
  })

  it('add: one attempt with the identities, entry method, target and the additional flag', () => {
    const quick = fakeQuick()
    const props = quickAddCardProps(quick, 'BARCODE', identities, target)

    props.onAdd(false)
    props.onAdd(true)

    expect(quick.add).toHaveBeenNthCalledWith(1, {
      identities,
      entryMethod: 'BARCODE',
      additional: false,
      target,
    })
    expect(quick.add).toHaveBeenNthCalledWith(2, {
      identities,
      entryMethod: 'BARCODE',
      additional: true,
      target,
    })
  })

  it('retry: the same identities, nothing else', () => {
    const quick = fakeQuick()

    quickAddCardProps(quick, 'MANUAL', identities, target).onRetry()

    expect(quick.retry).toHaveBeenCalledWith(identities)
    expect(quick.add).not.toHaveBeenCalled()
  })

  it('does not add anything until the card asks', () => {
    const quick = fakeQuick()

    quickAddCardProps(quick, 'MANUAL', identities, target)

    expect(quick.add).not.toHaveBeenCalled()
    expect(quick.retry).not.toHaveBeenCalled()
  })
})
