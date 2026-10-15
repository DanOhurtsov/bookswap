import type { QuickAddTarget } from '@bookswap/shared'
import {
  isOwned,
  quickAddActionsView,
  quickAddCardProps,
  quickAddStatusText,
} from './quick-add-card'
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

const pending: QuickAddSlot = {
  status: 'pending',
  operationId: 'op',
  request: { operationId: 'op', target },
  added: 0,
}
const unknown: QuickAddSlot = {
  status: 'unknown',
  operationId: 'op',
  request: { operationId: 'op', target },
  added: 0,
  message: 'мережа',
}

describe('isOwned', () => {
  it('the server knows an active copy, or this session confirmed an add', () => {
    expect(isOwned(undefined, { activeCount: 1, archivedCount: 0 })).toBe(true)
    expect(isOwned({ status: 'done', added: 1, copyId: 'c', editionId: 'e' }, undefined)).toBe(true)
  })

  it('stays owned while «one more copy» is in flight', () => {
    expect(isOwned({ ...pending, added: 1 }, undefined)).toBe(true)
  })

  it('an archived copy alone or a pending first add is not ownership', () => {
    expect(isOwned(undefined, { activeCount: 0, archivedCount: 2 })).toBe(false)
    expect(isOwned(pending, undefined)).toBe(false)
  })
})

describe('quickAddActionsView', () => {
  it('idle: «Додати до бібліотеки», refining allowed', () => {
    expect(quickAddActionsView(undefined, false)).toEqual({
      primary: { label: 'Додати до бібліотеки', command: 'add', busy: false },
      secondary: undefined,
      canRefine: true,
    })
  })

  it('pending: the same button says «Додаю…» and does nothing; no other operation can start', () => {
    expect(quickAddActionsView(pending, false)).toEqual({
      primary: { label: 'Додаю…', command: 'none', busy: true },
      secondary: undefined,
      canRefine: false,
    })
  })

  it('unknown: only checking the same operation again; refining is not a way around it', () => {
    expect(quickAddActionsView(unknown, false)).toEqual({
      primary: { label: 'Перевірити ще раз', command: 'retry', busy: false },
      secondary: undefined,
      canRefine: false,
    })
  })

  it('rejected: a new attempt and refining are both open', () => {
    const view = quickAddActionsView({ status: 'rejected', added: 0, message: 'ні' }, false)

    expect(view.primary.command).toBe('add')
    expect(view.canRefine).toBe(true)
  })

  it('owned: «✓» does nothing; one more copy is a separate secondary action', () => {
    expect(quickAddActionsView(undefined, true)).toEqual({
      primary: { label: '✓ У моїй бібліотеці', command: 'none', busy: false },
      secondary: { label: 'Додати ще один примірник', command: 'addAnother', busy: false },
      canRefine: false,
    })
    expect(quickAddActionsView({ ...pending, added: 1 }, true).secondary).toEqual({
      label: 'Додаю…',
      command: 'addAnother',
      busy: true,
    })
    expect(quickAddActionsView({ ...unknown, added: 1 }, true).secondary?.command).toBe('retry')
  })
})

describe('quickAddStatusText', () => {
  it('in-flight and unresolved states win over what the server knew', () => {
    const owned = { activeCount: 1, archivedCount: 0 }

    expect(quickAddStatusText(pending, owned)).toBe('Додаю…')
    expect(quickAddStatusText(unknown, owned)).toBe('Додавання не підтверджено')
  })

  it('owned, rejected, archived only, or nothing to say', () => {
    expect(quickAddStatusText(undefined, { activeCount: 1, archivedCount: 1 })).toBe(
      '✓ У моїй бібліотеці',
    )
    expect(quickAddStatusText({ status: 'rejected', added: 0, message: 'x' }, undefined)).toBe(
      'Не вдалося додати',
    )
    expect(quickAddStatusText(undefined, { activeCount: 0, archivedCount: 1 })).toBe(
      'Є у вашому архіві',
    )
    expect(quickAddStatusText(undefined, undefined)).toBeUndefined()
  })
})
