import { execFileSync } from 'node:child_process'

/**
 * Side-effect import: must be the FIRST import of a browser spec. `ConfigModule.forRoot({ validate })` reads
 * `process.env` when `AppModule` is first evaluated, so the guest-loans flags and `WEB_ORIGIN` (the origin the
 * browser will use for the web app, which API's CORS and e-mail links are built from) have to be set before
 * `auth.helpers` is loaded.
 *
 * The web port is picked by a short-lived child process, because a synchronous "find a free port" is not
 * possible in-process; the gap between releasing the port and `next dev` binding it is negligible.
 */
process.env.GUEST_LOANS_ENABLED = 'true'
process.env.GUEST_LOANS_SYNTHETIC_ONLY = 'true'

const port = execFileSync(
  process.execPath,
  [
    '-e',
    "const s=require('net').createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close()})",
  ],
  { encoding: 'utf8' },
)

export const WEB_PORT = Number(port)
export const WEB_ORIGIN = `http://localhost:${port}`

process.env.WEB_ORIGIN = WEB_ORIGIN

// Fail-closed щодо пошти: незалежно від оточення запуску чи кореневого `.env` (dotenv не перетирає вже задане)
// тест працює лише з локальним `DevEmailSender`. Ключі зовнішнього провайдера прибираються, щоб навіть
// помилкова конфігурація не мала чим викликати Resend. Значення не читаються й не виводяться.
process.env.EMAIL_PROVIDER = 'dev'
delete process.env.RESEND_API_KEY
delete process.env.EMAIL_FROM
