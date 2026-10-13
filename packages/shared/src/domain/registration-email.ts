/**
 * BS-129: which email domains may NOT be used to create a new account.
 *
 * This is an account-creation policy, not a property of an email address: login,
 * password reset, people search and invitations keep using `emailSchema` without
 * it, so an existing account on a blocked domain keeps working. The server
 * (`AuthService.register()`) and the registration form call the same function —
 * extending the list below is the only change a new suffix needs.
 */

/**
 * Blocked domain suffixes, written the way people type them. Each one matches the
 * domain itself and every subdomain, on a DNS label boundary: `.ru` blocks
 * `mail.example.ru`, but not `example.ru.com` or `notru.com`. The ASCII (Punycode)
 * form of each suffix is derived below, never written by hand.
 */
export const BLOCKED_REGISTRATION_EMAIL_DOMAIN_SUFFIXES = [
  'ru',
  'рф',
  'su',
  'рус',
  'moscow',
  'москва',
] as const

export const EMAIL_DOMAIN_BLOCKED_MESSAGE =
  'Реєстрація з цією поштовою адресою недоступна. Використайте email з іншим доменом.'

/**
 * Characters that make the WHATWG URL host parser read something other than a
 * hostname: a path, a port, userinfo, a query, a fragment, an IPv6 literal, a
 * percent-escape it would decode (`exa%2eru` → `exa.ru`), or whitespace and
 * controls it silently strips. A domain containing any of them is not a hostname
 * at all — it stays a format error for the email validators, never a match here.
 *
 * Checking the parsed URL's `port`/`pathname` afterwards would not be enough:
 * `example.ru:80` parses to an empty `port`, because 80 is the http default.
 */
const NON_HOSTNAME_CHARACTER = /[\s\p{Cc}/\\?#@:%[\]<>^|"]/u

/**
 * The domain's ASCII form per UTS #46 (lower case, Unicode labels as Punycode,
 * IDNA dot variants such as `。` mapped to `.`), produced by the URL host parser —
 * the same standard mechanism in the browser and in Node, without a dependency.
 * `undefined` when IDNA rejects the label.
 */
function toAsciiDomain(domain: string): string | undefined {
  try {
    return new URL(`http://${domain}/`).hostname
  } catch {
    return undefined
  }
}

const BLOCKED_SUFFIXES = BLOCKED_REGISTRATION_EMAIL_DOMAIN_SUFFIXES.flatMap((suffix) => [
  suffix,
  toAsciiDomain(suffix) ?? suffix,
])

function endsWithBlockedSuffix(domain: string): boolean {
  return BLOCKED_SUFFIXES.some((suffix) => domain.endsWith(`.${suffix}`))
}

/**
 * True when the email's domain (the part after the last `@`) ends with a blocked
 * suffix. The local part never counts: `ru.user@example.com` is allowed.
 *
 * Case and surrounding whitespace are normalized the same way as `emailSchema`.
 * The domain is compared both as typed and in its ASCII form, so `пошта.рф`,
 * `ПОШТА.РФ` and `xn--80a1acn3a.xn--p1ai` are the same domain here. The Unicode
 * comparison also covers a domain IDNA refuses to convert: such an address can
 * still pass `class-validator`'s `IsEmail`, and refusing to map it must not let
 * it through.
 *
 * Anything that is not a hostname (see `NON_HOSTNAME_CHARACTER`, empty labels)
 * is reported as not blocked: rejecting it is the job of the email format
 * validation, which always runs as well. No DNS or network lookup is made.
 */
export function isRegistrationEmailDomainBlocked(email: string): boolean {
  const address = email.trim().toLowerCase()
  const at = address.lastIndexOf('@')
  const domain = address.slice(at + 1).replace(/\.$/, '')

  if (at < 1 || NON_HOSTNAME_CHARACTER.test(domain)) return false
  if (domain.split('.').some((label) => label === '')) return false

  const ascii = toAsciiDomain(domain)?.replace(/\.$/, '')

  return (
    endsWithBlockedSuffix(domain.normalize('NFC')) ||
    (ascii !== undefined && endsWithBlockedSuffix(ascii))
  )
}
