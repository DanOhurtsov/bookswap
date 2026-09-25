'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Стан запиту, прив'язаного до КЛЮЧА (запит + сторінка + розмір…).
 *
 * «Ще шукаю» і «нічого не знайдено» — різні речі; `idle` — «питати ще нема про
 * що». Помилка несе саме помилку, а не рядок: як її показати, вирішує викликач.
 */
export type KeyedState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; error: unknown }

/**
 * Запит під ключем, який ніколи не показує відповіді на ІНШИЙ ключ.
 *
 * Стан зберігається РАЗОМ із ключем, до якого належить, а поточний виводиться під
 * час рендеру. Тому при зміні ключа в інтерфейсі жодної миті не видно попередню
 * відповідь — чужі книжки під новим словом чи чужу сторінку під новим номером — і
 * застаріла відповідь, що прийшла пізніше, нічого не перемальовує: її запит
 * скасовано (`AbortController`), а якщо ні — вона має чужий ключ.
 *
 * `key === undefined` — нічого питати: стан `idle`.
 */
export function useKeyedRequest<T>(
  key: string | undefined,
  load: (signal: AbortSignal) => Promise<T>,
): KeyedState<T> {
  const [stored, setStored] = useState<{ key: string; state: KeyedState<T> }>()
  // Завантажувач береться з посилання, а не з залежностей ефекту: нова стрілка на
  // кожному рендері не має перезапускати запит — його перезапускає лише ключ.
  const loadRef = useRef(load)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    if (key === undefined) return

    const controller = new AbortController()

    async function run(): Promise<void> {
      try {
        const value = await loadRef.current(controller.signal)

        if (controller.signal.aborted) return

        setStored({ key: key ?? '', state: { status: 'ready', value } })
      } catch (error) {
        // Скасований запит — це замінений запит, а не збій.
        if (controller.signal.aborted) return

        setStored({ key: key ?? '', state: { status: 'error', error } })
      }
    }

    void run()

    return () => {
      controller.abort()
    }
  }, [key])

  if (key === undefined) return { status: 'idle' }

  return stored?.key === key ? stored.state : { status: 'loading' }
}
