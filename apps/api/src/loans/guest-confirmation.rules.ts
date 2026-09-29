import { GUEST_LINK_TTL_DAYS } from '@bookswap/shared'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Stage 10 (10i.2): числа гостьової відповіді. Це ТЕХНІЧНІ значення, а не затверджені PO продуктові
 * правила (затверджено лише 7 днів посилання, §0.11 Q24, і шестизначний одноразовий код, §0.13 п. 4):
 * TTL коду/доказу й стелі хибних спроб/листів обрано як обмеження перебору й розсилки та описано в плані
 * як технічні припущення.
 *
 * `GUEST_LINK_TTL_MS` ДУБЛЮЄ CHECK `guest_confirmation_link_ttl` у БД (рівно 7 діб): зміна тут без міграції
 * зробить видачу неможливою — цей зв'язок навмисний, а не випадковий.
 */
export const GUEST_LINK_TTL_MS = GUEST_LINK_TTL_DAYS * DAY_MS
export const GUEST_CODE_TTL_MS = 10 * MINUTE_MS
export const GUEST_PROOF_TTL_MS = 30 * MINUTE_MS
/** Хибних спроб для одного коду: далі код гасне й потрібен новий. */
export const GUEST_CODE_MAX_ATTEMPTS = 5
/** Хибних спроб за все життя одного посилання: далі верифікація закрита до нової видачі власником. */
export const GUEST_CODE_MAX_FAILED_TOTAL = 10
/** Кодів на одне посилання за вікно. */
export const GUEST_CODE_MAX_SENDS_PER_WINDOW = 5
export const GUEST_CODE_SEND_WINDOW_MS = 60 * MINUTE_MS

/**
 * Поля, які обнуляють ПОСИЛАННЯ й усе, що від нього залежить (виклик, код, доказ, лічильники). Єдине
 * місце: його використовують і видача нового посилання (перед записом нових значень), і відповідь гостя,
 * і обидві дії власника — гасіння не може «забути» одне з полів.
 */
export const CLEARED_LINK_AND_CHALLENGE = {
  linkTokenHash: null,
  linkIssuedAt: null,
  linkExpiresAt: null,
  challengeMac: null,
  codeHash: null,
  codeExpiresAt: null,
  codeNonce: null,
  codeAttempts: 0,
  codeFailedTotal: 0,
  codeSentCount: 0,
  codeWindowStartedAt: null,
  proofHash: null,
  proofExpiresAt: null,
  verifiedAt: null,
} as const

/** Лише виклик і доказ (посилання лишається): для скидання при новому запиті коду або збої відправки. */
export const CLEARED_CHALLENGE = {
  challengeMac: null,
  codeHash: null,
  codeExpiresAt: null,
  codeNonce: null,
  codeAttempts: 0,
  proofHash: null,
  proofExpiresAt: null,
  verifiedAt: null,
} as const
