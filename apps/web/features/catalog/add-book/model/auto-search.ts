import {
  AUTO_SEARCH_EXTERNAL_MIN_CHARS,
  AUTO_SEARCH_LOCAL_MIN_CHARS,
  AUTO_SEARCH_RESULT_LIMIT,
} from '@bookswap/shared'

/**
 * Автопошук під час введення (`/catalog/new`): пороги й затримки в одному місці.
 *
 * Пороги й ліміт спільні із сервером (`@bookswap/shared`) — сервер перевіряє їх сам, а не довіряє
 * браузеру. Затримки — лише справа клієнта; кожна зміна тексту перезапускає обидва таймери.
 */
export const AUTO_LOCAL_MIN_CHARS = AUTO_SEARCH_LOCAL_MIN_CHARS
export const AUTO_EXTERNAL_MIN_CHARS = AUTO_SEARCH_EXTERNAL_MIN_CHARS
export const AUTO_RESULT_LIMIT = AUTO_SEARCH_RESULT_LIMIT

/** Пауза після останньої зміни тексту перед пошуком у НАШОМУ каталозі. */
export const AUTO_LOCAL_DELAY_MS = 350
/** Пауза після останньої зміни тексту перед ОБМЕЖЕНИМ зовнішнім пошуком (Google Books, один запит). */
export const AUTO_EXTERNAL_DELAY_MS = 900

/** Адреса автопошуку несе цей параметр; без нього `q` — виконаний повний пошук. */
export const AUTO_PARAM = 'auto'

/**
 * Нормалізований запит: NFC, зайві пробіли згорнуті, краї обрізані.
 *
 * Порівнюються саме нормалізовані рядки: «кобзар », «кобзар» і «кобзар  » — один запит, а зміна лише
 * пробілів не запускає нового пошуку.
 */
export function normalizeQuery(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}
