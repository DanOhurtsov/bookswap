'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiRequestError, apiRequest, describeError } from './api'
import {
  requestKey,
  visibleState,
  type ResourceSnapshot,
  type ResourceState,
} from './resource-state'
import type { ZodType } from 'zod'

export type { ResourceState } from './resource-state'

/**
 * Одне джерело правди для «завантажити GET і показати три стани».
 *
 * До нього кожен хук мав власну копію циклу `useState` + `useEffect` +
 * `AbortController` + лічильник, і в кожній копії жили ті самі помилки:
 * застарілі дані під новим заголовком і `reload()`, на який не можна чекати.
 *
 * Правило «що показувати» винесене в чистий `resource-state.ts` і покрите
 * тестами; тут лишилися тільки React-обвʼязка й координація очікувачів.
 */
export interface Resource<TData> {
  state: ResourceState<TData>
  /**
   * Перезавантаження, на яке можна **чекати**: `Promise` резолвиться після
   * завершення саме того запиту, який цей виклик спричинив — і після помилки
   * теж, бо кнопки треба розблокувати в будь-якому разі.
   */
  reload: () => Promise<void>
}

/**
 * Черга очікувачів `reload()`.
 *
 * `pending` — ті, хто вже попросив оновлення, але чиє покоління ще не стартувало.
 * Кожен запуск ефекту **забирає** цю чергу собі і лише він має право її
 * звільнити. Без цього прибирання попереднього ефекту (React виконує його ПЕРЕД
 * запуском нового) резолвило б очікувача, доданого щойно викликаним `reload()`,
 * ще до старту нового GET.
 */
interface Waiters {
  pending: (() => void)[]
  mounted: boolean
}

export function useApiResource<TData>(path: string, schema: ZodType<TData>): Resource<TData> {
  const [nonce, setNonce] = useState(0)
  const [snapshot, setSnapshot] = useState<ResourceSnapshot<TData> | null>(null)
  const waiters = useRef<Waiters>({ pending: [], mounted: true })

  const key = requestKey(nonce, schema, path)

  /**
   * Номер покоління запиту.
   *
   * Ключ сам по собі не унікальний: сценарій A → B → A дає для другого A рівно
   * той самий ключ, що й для першого, тож слід першого видавався б за відповідь
   * другого, поки той іще летить. Лічильник це розводить.
   *
   * Росте він саме на зміну ключа — а ключ і є повним списком залежностей
   * ефекту (шлях, схема, лічильник `reload`). Тому «нове покоління» і «новий
   * запуск ефекту» — це те саме, і рендер знає номер, не питаючи в ефекту.
   *
   * Коригування стану **під час рендеру** — документований React-патерн для
   * «входи змінилися, скинь похідне». React перерендерить одразу, нічого не
   * закомітивши; варіант із `setState` в ефекті дав би зайвий кадр зі старими
   * даними, а `useRef` довелося б читати під час рендеру.
   */
  const [tracked, setTracked] = useState({ key, generation: 1 })

  if (tracked.key !== key) setTracked({ key, generation: tracked.generation + 1 })

  const generation = tracked.key === key ? tracked.generation : tracked.generation + 1

  useEffect(() => {
    const controller = new AbortController()
    // Обʼєкт черги створюється один раз і ніколи не підмінюється, тож копія
    // посилання в замиканні безпечна — і саме її вимагає правило про ref'и в
    // прибиранні ефекту.
    const queue = waiters.current

    // Це покоління забирає всіх, хто чекав на «наступний запуск», — і стає
    // єдиним, хто має право їх звільнити.
    const claimed = queue.pending

    queue.pending = []

    /** Чи це покоління вже змінене наступним. Локальна змінна — на кожен запуск своя. */
    let superseded = false

    async function load(): Promise<void> {
      try {
        const data = await apiRequest(path, { schema, signal: controller.signal })

        // Після `abort` або розмонтування компонент або вже чекає на інший запит,
        // або його немає: писати сюди означало б відповісти на скасоване питання.
        if (controller.signal.aborted || !queue.mounted) return

        setSnapshot({ key, generation, state: { status: 'ready', data } })
      } catch (error) {
        if (controller.signal.aborted || !queue.mounted) return

        setSnapshot({
          key,
          generation,
          state: {
            status: 'error',
            message: describeError(error),
            ...(error instanceof ApiRequestError ? { httpStatus: error.status } : {}),
          },
        })
      }
    }

    void load().finally(() => {
      // Скасоване покоління нікого не звільняє: його очікувачів уже всиновило
      // наступне (див. прибирання нижче), і подвійний резолв означав би, що
      // `reload()` завершився на даних, яких він не дочекався.
      if (superseded) return

      // `splice` і забирає, і спорожняє: якщо прибирання прийде після цього
      // рядка, повертати в чергу буде вже нічого.
      for (const resolve of claimed.splice(0)) resolve()
    })

    return () => {
      superseded = true
      controller.abort()

      // Прибирання лише скасовує запит. Очікувачі повертаються в чергу — їх
      // забере наступне покоління, бо вони чекають на свіжі дані, а не на
      // конкретний HTTP-виклик. При розмонтуванні їх звільнить ефект нижче.
      if (claimed.length > 0) queue.pending.unshift(...claimed.splice(0))
    }
  }, [key, generation, path, schema])

  /**
   * Життєвий цикл черги.
   *
   * Оголошений ПІСЛЯ основного ефекту навмисно: React виконує прибирання в
   * порядку оголошення, тож спершу основний ефект поверне своїх очікувачів у
   * чергу, а вже потім цей звільнить усю чергу. Зворотний порядок лишив би
   * `claimed` осиротілими, а `await reload()` у компоненті, який щойно зник, —
   * висіти назавжди.
   *
   * `mounted = true` у тілі, а не лише в ініціалізаторі `useRef`: у StrictMode
   * React монтує, розмонтовує й монтує знову тим самим екземпляром хука. Без
   * цього рядка прапорець лишався б `false` після повторного монтування, і в
   * режимі розробки сторінка назавжди зависала б на «Завантажую…».
   */
  useEffect(() => {
    const queue = waiters.current

    queue.mounted = true

    return () => {
      queue.mounted = false

      for (const resolve of queue.pending.splice(0)) resolve()
    }
  }, [])

  const state = visibleState(snapshot, key, generation)

  const reload = useCallback(() => {
    // Виклик після розмонтування не має лишати незавершений промис: чекати вже
    // нема на що, і нове покоління ніколи не стартує.
    if (!waiters.current.mounted) return Promise.resolve()

    return new Promise<void>((resolve) => {
      waiters.current.pending.push(resolve)
      setNonce((value) => value + 1)
    })
  }, [])

  return { state, reload }
}
