'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isValidIsbn13 } from '@bookswap/shared'
import {
  AUTO_EXTERNAL_DELAY_MS,
  AUTO_EXTERNAL_MIN_CHARS,
  AUTO_LOCAL_DELAY_MS,
  AUTO_LOCAL_MIN_CHARS,
  normalizeQuery,
} from './auto-search'

export interface AutoSearchInput {
  /** Що зараз у полі, як набрано. Це ЧЕРНЕТКА — виконаний запит живе в адресі. */
  draft: string
  /** Нормалізований `q` з адреси. */
  urlQuery: string
  /** Адреса в режимі автопідказок (`auto=1`), а не виконаного повного пошуку. */
  autoMode: boolean
  /** Показати підказки для цього тексту: `router.replace` з `auto=1`, без прокручування. */
  onSuggest: (query: string) => void
  /** Поле спорожніло: прибрати підказки з адреси. Виконаний повний пошук не чіпається. */
  onClear: () => void
  /** Валідний ISBN-13: точний сценарій без очікування. */
  onExact: (isbn: string) => void
}

export interface AutoSearch {
  /** Нормалізована чернетка. */
  normalized: string
  /** Для якого тексту вже питали зовнішнє джерело; `undefined` — ще ні. */
  externalAsked: string | undefined
  /** Нормалізована чернетка ще не відбилась в адресі (чекаємо паузу або триває IME). */
  localPending: boolean
  /** Пропси для `<input>`: композиція IME. */
  composition: {
    onCompositionStart: () => void
    onCompositionEnd: () => void
  }
  /** Зняти відкладені запуски — перед явним повним пошуком. */
  cancel: () => void
  /** Адреса змінилась ззовні (Back/Forward, сканер): підказки відновлюються без паузи. */
  restore: (query: string | undefined) => void
}

/**
 * Автопошук під час введення: КОЛИ що запускається. Сам хук нічого не завантажує — він лише вирішує
 * й викликає колбеки; запити роблять `useKeyedRequest`-и екрана за ключем, який із цього виходить.
 *
 * - до 2 символів — нічого; від 2 — через `AUTO_LOCAL_DELAY_MS` підказки з нашого каталогу;
 *   від 3 — через `AUTO_EXTERNAL_DELAY_MS` ще й обмежене зовнішнє питання. Таймери НЕЗАЛЕЖНІ й
 *   рахуються від ОСТАННЬОЇ зміни тексту: перший, що спрацював, другого не скидає.
 * - IME: поки триває композиція, таймерів немає; `compositionend` вмикає їх для завершеного тексту.
 * - валідний ISBN-13 — без очікування (`onExact`); «1984» ISBN не є.
 * - порівнюються нормалізовані рядки: зміна лише пробілів нічого не запускає.
 *
 * Таймери залежать лише від тексту й композиції, а не від адреси: інакше `replace`, який робить
 * сам локальний таймер, перезапускав би зовнішній і той спрацьовував би на `350 + 900` мс.
 */
export function useAutoSearch(input: AutoSearchInput): AutoSearch {
  const normalized = normalizeQuery(input.draft)
  const [composing, setComposing] = useState(false)
  const [externalAsked, setExternalAsked] = useState<string | undefined>(
    input.autoMode && input.urlQuery.length >= AUTO_EXTERNAL_MIN_CHARS ? input.urlQuery : undefined,
  )
  const latest = useRef(input)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  useEffect(() => {
    latest.current = input
  })

  const cancel = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)

    timers.current = []
  }, [])

  const restore = useCallback((query: string | undefined) => {
    setExternalAsked(
      query !== undefined && query.length >= AUTO_EXTERNAL_MIN_CHARS ? query : undefined,
    )
  }, [])

  useEffect(() => {
    if (composing) return

    const current = latest.current

    if (normalized.length < AUTO_LOCAL_MIN_CHARS) {
      if (current.autoMode && current.urlQuery !== '') current.onClear()

      return
    }

    if (isValidIsbn13(normalized)) {
      if (normalized !== current.urlQuery || current.autoMode) current.onExact(normalized)

      return
    }

    // Решту вирішує момент спрацювання: адреса за ці 350–900 мс могла змінитись.
    timers.current = [
      setTimeout(() => {
        if (normalized !== latest.current.urlQuery) latest.current.onSuggest(normalized)
      }, AUTO_LOCAL_DELAY_MS),
    ]

    if (normalized.length >= AUTO_EXTERNAL_MIN_CHARS) {
      timers.current.push(
        setTimeout(() => {
          const now = latest.current

          // Виконаний повний пошук цього ж тексту вже питав усі джерела: підказки зайві.
          if (normalized === now.urlQuery && !now.autoMode) return

          setExternalAsked(normalized)
        }, AUTO_EXTERNAL_DELAY_MS),
      )
    }

    return cancel
  }, [normalized, composing, cancel])

  const isbn = isValidIsbn13(normalized)
  const eligible = !composing && !isbn && normalized.length >= AUTO_LOCAL_MIN_CHARS

  return {
    normalized,
    externalAsked,
    localPending: composing || (eligible && normalized !== input.urlQuery),
    composition: {
      onCompositionStart: () => {
        setComposing(true)
      },
      onCompositionEnd: () => {
        setComposing(false)
      },
    },
    cancel,
    restore,
  }
}
