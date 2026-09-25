import { ApiRequestError, describeError } from '@/app/lib/api'

const MESSAGES: Partial<Record<string, string>> = {
  INVITE_RATE_LIMITED: 'Забагато запрошень поштою. Спробуйте пізніше або поділіться посиланням.',
  INVITE_EMAIL_UNVERIFIED: 'Щоб надсилати запрошення поштою, підтвердьте власну адресу в профілі.',
  INVITE_EMAIL_FAILED: 'Не вдалося надіслати лист. Це запрошення скасовано — створіть нове.',
  VALIDATION_ERROR: 'Перевірте адресу: вона має бути у форматі name@example.com.',
  TOO_MANY_REQUESTS: 'Забагато спроб. Зачекайте хвилину й спробуйте ще раз.',
}

export function describeInviteError(error: unknown): string {
  if (error instanceof ApiRequestError) return MESSAGES[error.code] ?? error.message

  return describeError(error)
}
