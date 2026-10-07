/**
 * Side-effect import: must be the FIRST import of a file that needs a known invite-HMAC key.
 * `ConfigModule.forRoot({ validate })` reads `process.env` once, when `AppModule` is first
 * evaluated, and dotenv never overrides a variable that is already set. So the key has to be in
 * `process.env` before `auth.helpers` is loaded — otherwise an `INVITE_EMAIL_HMAC_SECRET` from a
 * developer's own root `.env` wins and the test's expected hashes no longer match the app's.
 */
export const INVITE_HMAC_TEST_SECRET = 'invite-hmac-test-secret-0123456789abcdef'

const previous = process.env.INVITE_EMAIL_HMAC_SECRET

process.env.INVITE_EMAIL_HMAC_SECRET = INVITE_HMAC_TEST_SECRET

/** Puts `INVITE_EMAIL_HMAC_SECRET` back as it was before the import; call it from `afterAll`. */
export function restoreInviteHmacSecret(): void {
  if (previous === undefined) delete process.env.INVITE_EMAIL_HMAC_SECRET
  else process.env.INVITE_EMAIL_HMAC_SECRET = previous
}
