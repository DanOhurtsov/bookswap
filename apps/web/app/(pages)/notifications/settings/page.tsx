'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import {
  DIGEST_NOTIFICATION_TYPE,
  NOTIFICATION_TYPE,
  isDigestNotificationType,
  isGuestResponseNotificationType,
  telegramLinkResponseSchema,
  type NotificationPreferencesResponse,
  type NotificationType,
  type PreferenceChannel,
  type TelegramLinkResponse,
} from '@bookswap/shared'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FormStatus } from '@/components/Form/FormStatus'
import { ApiRequestError, apiRequest, describeError } from '../../../lib/api'
import { CHANNEL_LABELS, NOTIFICATION_TYPE_LABELS } from '../../../lib/labels'
import {
  changedCells,
  channelStates,
  formatCountdown,
  linkTimeLeftMs,
  telegramChannelAction,
  toMatrix,
  toggleCell,
  type ChannelState,
  type PreferenceMatrix,
} from '../../../lib/notification-preferences'
import { displayDecision } from '../../../lib/resource-state'
import { useNotificationPreferences } from '../../../lib/use-notification-preferences'
import { useSession } from '../../../lib/use-session'

/**
 * §7.6 і §7.4: матриця «тип події × канал», стан каналів і прив'язка Telegram.
 *
 * Уся логіка матриці — у чистому `lib/notification-preferences.ts`: цей файл лише
 * малює. Причина не в естетиці, а в тому, що `apps/web` тестує тільки `.ts` у
 * `app/lib`, і злиття дефолтів із збереженим станом мусить бути перевіреним.
 */
export default function NotificationSettingsPage() {
  const router = useRouter()
  const { state: session } = useSession()

  useEffect(() => {
    if (session.status === 'guest') router.replace('/login')
  }, [session.status, router])

  if (session.status === 'loading') {
    return (
      <Shell>
        <p className="status status--pending">Перевіряю сесію…</p>
      </Shell>
    )
  }

  if (session.status === 'error') {
    return (
      <Shell>
        <FormStatus error={new Error(session.message)} />
      </Shell>
    )
  }

  if (session.status !== 'authenticated') {
    return (
      <Shell>
        <p className="status status--pending">Потрібен вхід. Переадресовую…</p>
      </Shell>
    )
  }

  return <SettingsScreen />
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="page">
      <h1>Налаштування сповіщень</h1>
      {children}
      <p className="form__aside">
        <Link href="/notifications">Сповіщення</Link> · <Link href="/profile">Профіль</Link> ·{' '}
        <Link href="/">На головну</Link>
      </p>
    </main>
  )
}

function SettingsScreen() {
  const { state, reload } = useNotificationPreferences()

  /**
   * Повідомлення про успіх живе **над** формою, а не в ній.
   *
   * Збереження й відв'язка закінчуються `reload()`, а той може перемонтувати
   * форму (стан Telegram змінився — змінився `key`). Стан, який жив усередині,
   * зникав би разом із нею: людина натискала «Відключити», бачила, як зникає
   * кнопка, і не отримувала жодного підтвердження, що дія вдалася.
   */
  const [notice, setNotice] = useState<string>()

  /**
   * Останні успішно завантажені дані — окремо від `state.status`.
   *
   * §4 дефекту: `useApiResource` навмисно віддає `status: 'loading'` на КОЖЕН
   * запуск нового покоління запиту, включно з фоновим `reload()` (наприклад,
   * після «Я натиснув Start — перевірити»), а не лише на перший. Без цього
   * поля старий код рендерив повноекранне «Завантажую…» замість форми на
   * кожен такий reload — форма (і разом із нею `deepLink` посилання на бота)
   * розмонтовувалася й губилася, навіть коли `connected` лишався `false`, а
   * не через зміну `key`. Початкове завантаження (нема ще жодних даних) і
   * фонове оновлення (дані вже є, летить свіжіша версія) — це різні стани для
   * людини, і показувати їх однаково не можна.
   */
  const [lastData, setLastData] = useState<NotificationPreferencesResponse>()

  // Коригування стану ПІД ЧАС рендеру — той самий документований React-патерн
  // «входи змінилися, онови похідне», яким уже користується `use-resource.ts`
  // для `tracked`: React перерендерить одразу, нічого не закомітивши, а
  // `useEffect` тут додав би зайвий кадр зі старими даними на екрані.
  if (state.status === 'ready' && state.data !== lastData) setLastData(state.data)

  // Усе рішення «що малювати» — в одній чистій, перевіреній функції
  // (`resource-state.spec.ts`): яка комбінація status/lastData дає форму,
  // індикатор оновлення чи фонову помилку — не гілки тут.
  const { data, refreshing, backgroundErrorMessage } = displayDecision(state, lastData)

  // Даних узагалі ще нема: або це справді перший запит, або він упав до
  // того, як щось було показано. Тільки тут виправдане повноекранне «нема
  // форми» — у решті випадків форма лишається на екрані.
  if (data === undefined) {
    if (state.status === 'error') {
      return (
        <Shell>
          <FormStatus error={new Error(state.message)} />
        </Shell>
      )
    }

    return (
      <Shell>
        <p className="status status--pending">Завантажую налаштування…</p>
      </Shell>
    )
  }

  return (
    <Shell>
      {/* Дані вже є (можливо, застарілі на секунду фонового reload) — форма
          лишається змонтованою; окремий, ненав'язливий індикатор нижче каже,
          що йде оновлення, не забираючи форму з-під рук людини. */}
      {refreshing && <p className="status status--pending">Оновлюю…</p>}

      {/* Дефект: фонова помилка (5xx/мережа під час «Я натиснув Start —
          перевірити») раніше не показувалася ВЗАГАЛІ, поки лишалися старі
          дані, — людина бачила стару форму й жодного натяку, що перевірка не
          пройшла. Ненавʼязливий, а не сторінка-заміна: форма й `deepLink`
          лишаються на місці, банер лише повідомляє. Зникає сам собою на
          наступному вдалому reload() — `state.status` тоді стає `'ready'`,
          і `backgroundErrorMessage` просто перестає обчислюватися, без
          окремого стану чи ефекту. */}
      {backgroundErrorMessage !== undefined && (
        <FormStatus error={new Error(`Не вдалося оновити: ${backgroundErrorMessage}`)} />
      )}

      {/* `key` перемонтовує форму після зміни стану Telegram: інакше локальна
          матриця пережила б підключення й показувала б стару колонку. */}
      <SettingsForm
        key={data.channels.telegram.connected ? 'linked' : 'unlinked'}
        data={data}
        reload={reload}
        notice={notice}
        onNotice={setNotice}
      />
    </Shell>
  )
}

interface FormProps {
  data: NotificationPreferencesResponse
  reload: () => Promise<void>
  notice: string | undefined
  onNotice: (notice: string | undefined) => void
}

function SettingsForm({ data, reload, notice, onNotice }: FormProps) {
  const linked = data.channels.telegram.connected
  const saved = toMatrix(data.preferences, linked)

  const [matrix, setMatrix] = useState<PreferenceMatrix>(saved)
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [deepLink, setDeepLink] = useState<TelegramLinkResponse>()
  const [confirmUnlink, setConfirmUnlink] = useState(false)

  const pending = changedCells(saved, matrix)
  const states = channelStates(data.channels)
  const telegram = data.channels.telegram

  async function run(action: () => Promise<string | undefined>): Promise<void> {
    setFailure(undefined)
    onNotice(undefined)
    setBusy(true)

    try {
      onNotice(await action())
    } catch (error) {
      setFailure(error instanceof ApiRequestError ? error : new Error(describeError(error)))
    } finally {
      setBusy(false)
    }
  }

  function save(): void {
    void run(async () => {
      // Порожній список API відхиляє (400) — і правильно робить: він нічого не
      // означає. Тому кнопка вимкнена, а це лише страховка.
      if (pending.length === 0) return 'Змін немає.'

      await apiRequest('/me/notification-preferences', {
        method: 'PUT',
        body: { preferences: pending },
      })

      await reload()

      return 'Налаштування збережено.'
    })
  }

  function connect(): void {
    void run(async () => {
      setDeepLink(
        await apiRequest('/me/telegram/link', {
          method: 'POST',
          schema: telegramLinkResponseSchema,
        }),
      )

      return undefined
    })
  }

  function unlink(): void {
    setConfirmUnlink(false)

    void run(async () => {
      await apiRequest('/me/telegram', { method: 'DELETE' })
      setDeepLink(undefined)
      await reload()

      return 'Telegram відключено.'
    })
  }

  return (
    <>
      <FormStatus error={failure} success={notice} />

      <section className="channels">
        <h2>Канали</h2>

        {states.map((channel) => (
          <div className="channel" key={channel.channel}>
            <div>
              <strong>{CHANNEL_LABELS[channel.channel]}</strong>
              <p className="channel__detail">{channel.detail}</p>
            </div>
            <ChannelAction
              channel={channel}
              busy={busy}
              onConnect={connect}
              onUnlink={() => {
                setConfirmUnlink(true)
              }}
            />
          </div>
        ))}

        {deepLink !== undefined && !linked && (
          <TelegramLinkPrompt key={deepLink.deepLink} link={deepLink} onCheck={reload} />
        )}

        {!telegram.configured && (
          <p className="field__hint">
            Telegram-бот не налаштований на цьому сервері, тож підключити його зараз неможливо.
            Решта каналів працює як звичайно.
          </p>
        )}
      </section>

      <section>
        <h2>Що надсилати</h2>
        <p className="lede">
          Кожен канал вмикається окремо. Вимкнені всюди події не зникають — вони просто нікуди не
          надсилаються й не потрапляють у список на сайті.
        </p>

        <div className="matrix-scroll">
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">Подія</th>
                {states.map((channel) => (
                  <th key={channel.channel} scope="col">
                    {CHANNEL_LABELS[channel.channel]}
                    <span className="matrix__detail">{channel.detail}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_TYPE.map((type) => (
                <tr key={type}>
                  <th scope="row">
                    {NOTIFICATION_TYPE_LABELS[type]}
                    {isDigestNotificationType(type) && (
                      <span className="matrix__detail">одним дайджестом або повідомленням</span>
                    )}
                    {isGuestResponseNotificationType(type) && (
                      <span className="matrix__detail">
                        пошта — лише загальне нагадування без подробиць; Telegram недоступний
                      </span>
                    )}
                  </th>
                  {states.map((channel) => (
                    <td key={channel.channel}>
                      <Cell
                        type={type}
                        channel={channel.channel}
                        checked={matrix[type][channel.channel]}
                        disabled={
                          busy ||
                          !channel.editable ||
                          (channel.channel === 'TELEGRAM' && isGuestResponseNotificationType(type))
                        }
                        onToggle={() => {
                          setMatrix(toggleCell(matrix, type, channel.channel))
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* §7.5: другу групу не можна надсилати негайно — активний користувач
            перетворив би бота на спам, і його вимкнули б разом із важливим. */}
        <p className="field__hint">
          «{DIGEST_NOTIFICATION_TYPE.map((type) => NOTIFICATION_TYPE_LABELS[type]).join('» і «')}» —
          щоденним дайджестом: одне повідомлення на всі книжки, а не по одному на кожну.
        </p>

        <div className="actions">
          <button type="button" disabled={busy || pending.length === 0} onClick={save}>
            {busy ? 'Зберігаю…' : 'Зберегти'}
          </button>
          <button
            type="button"
            className="button--ghost"
            disabled={busy || pending.length === 0}
            onClick={() => {
              setMatrix(saved)
            }}
          >
            Скасувати зміни
          </button>
        </div>
      </section>

      <ConfirmDialog
        open={confirmUnlink}
        title="Відключити Telegram?"
        description="Сповіщення перестануть приходити в бота. Налаштування збережуться — після повторного підключення вони повернуться."
        confirmLabel="Відключити"
        pending={busy}
        onConfirm={unlink}
        onCancel={() => {
          setConfirmUnlink(false)
        }}
      />
    </>
  )
}

interface ChannelActionProps {
  channel: ChannelState
  busy: boolean
  onConnect: () => void
  onUnlink: () => void
}

/**
 * Дія над каналом — рівно та, яка щось змінить.
 *
 * Неналаштований на сервері канал не отримує кнопки взагалі: «Підключити» там,
 * де підключати нема до чого, — обіцянка, яку інтерфейс не виконає.
 */
function ChannelAction({ channel, busy, onConnect, onUnlink }: ChannelActionProps) {
  if (channel.channel !== 'TELEGRAM') {
    return <span className="badge">{channel.available ? 'Активно' : 'Недоступно'}</span>
  }

  // Рішення «яку дію показати» — чиста функція в `lib/notification-preferences.ts`,
  // а не гілки тут: саме там живе перевірений порядок `connected` → `configured`.
  switch (telegramChannelAction(channel)) {
    case 'unlink':
      return (
        <button type="button" className="button--danger" disabled={busy} onClick={onUnlink}>
          Відключити
        </button>
      )
    case 'unavailable':
      return <span className="badge">Недоступно</span>
    case 'connect':
      return (
        <button type="button" disabled={busy} onClick={onConnect}>
          Підключити
        </button>
      )
  }
}

interface LinkPromptProps {
  link: TelegramLinkResponse
  onCheck: () => Promise<void>
}

/**
 * Посилання на бота з живим відліком (§7.4: TTL 10 хвилин).
 *
 * Прострочене посилання **прибирається**, а не лишається клікабельним: воно
 * виглядало б робочим, а закінчувалося відмовою бота — і людина вирішила б,
 * що зламався сервіс, а не що минуло десять хвилин. Але прибирається лише
 * САМЕ ПОСИЛАННЯ (`<a href>`) — попередження про прострочення нижче лишається
 * на екрані, поки людина сама не натисне «Підключити» ще раз.
 *
 * Раніше компонент сам себе ховав: `useEffect` викликав `onExpire(undefined)`,
 * батько зачищав `deepLink`, і `{deepLink !== undefined && …}` в
 * `SettingsForm` тієї ж миті знімав цей компонент з дерева — те саме
 * попередження, яке мало пояснити людині, що сталося, зникало за один кадр
 * після появи. Компонент більше нікого не повідомляє про власне
 * прострочення — рішення «протухло чи ні» лишається суто похідним від
 * `link.expiresAt`, а не станом, який хтось інший може прибрати з-під нього.
 *
 * `key={deepLink.deepLink}` на виклику вище — не косметика. Нове посилання
 * (людина натиснула «Підключити» ще раз після протухлого) має унікальний токен
 * у самому `deepLink`; час `expiresAt` теоретично може збігтися до мілісекунди.
 * Без зміни `key` React лишив би той самий екземпляр компонента: `left`
 * — це `useState`, тож ІНІЦІАЛІЗАТОР більше не спрацював би, і застарілий
 * відлік (чи «протухло» від ПОПЕРЕДНЬОГО посилання) лишався б на екрані аж до
 * першого тика `setInterval` нижче — тобто видимо до секунди. Ключ примушує
 * повний перемонт: `left` рахується заново з чистого `useState`-ініціалізатора
 * на ПЕРШОМУ рендері нового екземпляра, без жодного проміжного кадру.
 */
function TelegramLinkPrompt({ link, onCheck }: LinkPromptProps) {
  const [left, setLeft] = useState(() => linkTimeLeftMs(link.expiresAt, Date.now()))

  useEffect(() => {
    const timer = setInterval(() => {
      const remaining = linkTimeLeftMs(link.expiresAt, Date.now())

      setLeft(remaining)

      // Далі цокати нема сенсу: `remaining` тепер назавжди `null`, доки
      // `link` (а разом із ним і цей ефект) не заміниться новим посиланням.
      if (remaining === null) clearInterval(timer)
    }, 1000)

    return () => {
      clearInterval(timer)
    }
  }, [link.expiresAt])

  if (left === null) {
    return (
      <div className="alert alert--warn" role="status">
        <p>Посилання протухло. Натисніть «Підключити» ще раз.</p>
      </div>
    )
  }

  return (
    <div className="alert alert--warn" role="status">
      <p>
        Відкрийте бота й натисніть Start. Посилання спрацює один раз і діє ще{' '}
        <strong>{formatCountdown(left)}</strong>.
      </p>
      <p>
        {/* Звичайне посилання, а не автоматичне перенаправлення: людина має
            бачити, куди йде, а перехід у застосунок з-під коду браузери
            блокують по-різному. */}
        <a href={link.deepLink} target="_blank" rel="noreferrer">
          Відкрити Telegram
        </a>
      </p>
      <p>
        <button
          type="button"
          className="button--link"
          onClick={() => {
            void onCheck()
          }}
        >
          Я натиснув Start — перевірити
        </button>
      </p>
    </div>
  )
}

interface CellProps {
  type: NotificationType
  channel: PreferenceChannel
  checked: boolean
  disabled: boolean
  onToggle: () => void
}

/**
 * Прапорець без видимого підпису: підпис — це заголовки рядка й колонки.
 *
 * Тому `aria-label` обов'язковий: без нього екранний читач у клітинці таблиці
 * оголосив би просто «прапорець, не позначено», і зв'язок із подією та каналом
 * загубився б.
 */
function Cell({ type, channel, checked, disabled, onToggle }: CellProps) {
  const label = `${NOTIFICATION_TYPE_LABELS[type]} — ${CHANNEL_LABELS[channel]}`

  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onToggle}
    />
  )
}
