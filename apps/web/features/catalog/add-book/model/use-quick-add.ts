'use client'

import {
  type CopyEntryMethod,
  type QuickAddRequest,
  type QuickAddResponse,
  type QuickAddTarget,
} from '@bookswap/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { ApiRequestError } from '@/app/lib/api'
import { describeAddBookError } from '@/app/lib/catalog-errors'
import { invalidateActivation } from '@/features/library/activation/index.client'
import { quickAdd } from '../api/add-search'
import { forgetPending, readPending, rememberPending } from './quick-add-storage'
import {
  EMPTY_SLOTS,
  classifyFailure,
  newOperationId,
  quickAddSlotsReducer,
  slotKeyOf,
  slotOf,
  type QuickAddSlot,
} from './quick-add-slots'

export interface QuickAddAttempt {
  /** Усі відомі ідентичності цього видання: вони ділять один слот (див. `QuickAddSlot`). */
  identities: readonly string[]
  target: QuickAddTarget
  entryMethod: CopyEntryMethod
  /** Свідомо ще один фізичний примірник: нова операція навіть після `done`. */
  additional?: boolean
}

export interface QuickAddApi {
  slotFor: (identities: readonly string[]) => QuickAddSlot | undefined
  /** Початок дії. Під час `pending` ігнорується; з `unknown` повторює ТУ САМУ операцію. */
  add: (attempt: QuickAddAttempt) => void
  /** Повтор тієї самої операції з незмінним вмістом (стан `unknown`). */
  retry: (identities: readonly string[]) => void
}

/**
 * Додавання з картки (docs/plan/fast-book-add.md, §2.2, §6).
 *
 * Що гарантується:
 * - подвійний клік — один запит (`inFlight` перевіряється синхронно, до будь-якого рендеру);
 * - `operationId` один на НАМІР і зберігається між повторами; новий — лише для нової дії;
 * - «Додано» з'являється лише після відповіді сервера (`done`);
 * - після невідомого результату нова операція неможлива, доки попередню не з'ясовано повтором;
 * - незавершена операція переживає перезавантаження сторінки й повторюється автоматично.
 */
export function useQuickAdd(options: {
  userId: string
  onAdded: (response: QuickAddResponse) => void
}): QuickAddApi {
  const { userId, onAdded } = options
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(quickAddSlotsReducer, EMPTY_SLOTS)
  const stateRef = useRef(state)
  const inFlight = useRef(new Set<string>())
  const onAddedRef = useRef(onAdded)

  useEffect(() => {
    stateRef.current = state
    onAddedRef.current = onAdded
  })

  const run = useCallback(
    async (
      key: string,
      identities: readonly string[],
      operationId: string,
      request: QuickAddRequest,
    ): Promise<void> => {
      if (inFlight.current.has(key)) return

      inFlight.current.add(key)
      dispatch({ type: 'started', key, identities, operationId, request })
      rememberPending(userId, key, { operationId, identities: [...identities], request })

      try {
        const response = await quickAdd(request)

        forgetPending(userId, key)
        dispatch({
          type: 'done',
          key,
          identities,
          copyId: response.copy.id,
          editionId: response.edition.id,
        })
        // Лише після підтвердженого збереження; збій оновлення чекліста не скасовує додавання.
        await invalidateActivation(queryClient).catch(() => undefined)
        onAddedRef.current(response)
      } catch (error) {
        const message = describeAddBookError(error)

        if (classifyFailure(error) === 'rejected') {
          forgetPending(userId, key)
          dispatch({
            type: 'rejected',
            key,
            message,
            ...(error instanceof ApiRequestError
              ? { code: error.code, details: error.details }
              : {}),
          })
        } else {
          dispatch({ type: 'unknown', key, message })
        }
      } finally {
        inFlight.current.delete(key)
      }
    },
    [queryClient, userId],
  )

  const retry = useCallback(
    (identities: readonly string[]): void => {
      const key = slotKeyOf(stateRef.current, identities)
      const slot = stateRef.current.slots[key]

      if (slot?.status !== 'unknown') return

      void run(key, identities, slot.operationId, slot.request)
    },
    [run],
  )

  const add = useCallback(
    (attempt: QuickAddAttempt): void => {
      const key = slotKeyOf(stateRef.current, attempt.identities)
      const slot = stateRef.current.slots[key]

      if (inFlight.current.has(key) || slot?.status === 'pending') return

      // Результат попередньої дії невідомий: спершу з'ясовуємо його тією самою операцією.
      if (slot?.status === 'unknown') {
        retry(attempt.identities)

        return
      }

      if (slot?.status === 'done' && attempt.additional !== true) return

      const operationId = newOperationId()

      void run(key, attempt.identities, operationId, {
        operationId,
        entryMethod: attempt.entryMethod,
        target: attempt.target,
      })
    },
    [retry, run],
  )

  // Після перезавантаження: повторити те, що не встигло завершитися, — тією самою операцією.
  const resumedFor = useRef<string>(undefined)

  useEffect(() => {
    // Користувач ще невідомий (сесія вантажиться): повторювати нічого й не від чийого імені.
    if (userId === '' || resumedFor.current === userId) return

    resumedFor.current = userId

    for (const [key, entry] of Object.entries(readPending(userId))) {
      void run(key, entry.identities, entry.operationId, entry.request)
    }
  }, [run, userId])

  return {
    slotFor: (identities) => slotOf(state, identities),
    add,
    retry,
  }
}
