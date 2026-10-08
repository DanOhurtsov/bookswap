import { GUEST_RESPONSE_LIMITS } from '@bookswap/shared'

/**
 * Токен гостьового посилання їде у фрагменті URL: він не потрапляє ні в логи сервера, ні в `Referer`.
 * На відміну від запрошення 10g, тут НЕМАЄ жодного сховища браузера — токен лише в пам'яті
 * сторінки й нікуди не переживає її.
 */
export function guestTokenFromHash(hash: string): string | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash

  if (raw === '') return undefined

  try {
    const token = decodeURIComponent(raw).trim()

    return token.length > 0 && token.length <= GUEST_RESPONSE_LIMITS.tokenMax ? token : undefined
  } catch {
    return undefined
  }
}
