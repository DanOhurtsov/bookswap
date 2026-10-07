/**
 * Runs before the test modules (`setupFiles`, after `use-test-database.ts`): the test app sees the
 * Telegram bot as NOT configured whatever a developer keeps in their own root `.env` or shell.
 *
 * Without it a real bot token would turn `TELEGRAM_API` into the HTTP transport — real requests to
 * api.telegram.org from tests — and flip every spec that assumes the "no bot" state.
 *
 * The values reach the app by two routes, so both are closed:
 *  - `use-test-database.ts` loads the root `.env` into `process.env`, so the keys are deleted there;
 *  - `ConfigModule` then reads the file again with its OWN copy of `dotenv` (not the one `apps/api`
 *    depends on), so that copy's `parse` is wrapped to drop these keys.
 * Assigning `undefined` would not work: jest coerces `process.env` values to strings, and the text
 * "undefined" is a (invalid) value. A spec that needs a bot sets the variables itself, after this
 * runs. Nothing else about `.env` changes, and the validation production runs is untouched.
 */
const LOCAL_TELEGRAM_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
]

for (const key of LOCAL_TELEGRAM_KEYS) delete process.env[key]

const configModulesDotenv = require.resolve('dotenv', {
  paths: [require.resolve('@nestjs/config')],
})

jest.doMock(configModulesDotenv, () => {
  const actual = jest.requireActual<typeof import('dotenv')>(configModulesDotenv)

  return {
    ...actual,
    parse: (...args: Parameters<typeof actual.parse>) => {
      const parsed = actual.parse(...args)

      for (const key of LOCAL_TELEGRAM_KEYS) delete parsed[key]

      return parsed
    },
  }
})
