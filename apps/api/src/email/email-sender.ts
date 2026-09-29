/**
 * Порт для надсилання листів (§7.2).
 *
 * Інтерфейс з'являється зараз, бо етап акаунтів уже мусить щось надсилати —
 * підтвердження пошти й скидання пароля. Реалізація поки одна, dev'ова; Resend
 * або Postmark стають ще однією реалізацією цього самого порту на етапі
 * сповіщень, без правок у сервісі акаунтів.
 *
 * Черги, ретраїв і `NotificationDelivery` тут навмисно немає — це §7.3 і етап 3.
 */
export interface EmailMessage {
  to: string
  subject: string
  /** Текстове тіло. HTML з'явиться разом із реальним провайдером. */
  body: string
  /**
   * §7.3: ключ ідемпотентності на боці провайдера, там, де провайдер це
   * підтримує. `ResendEmailSender` передає його заголовком `Idempotency-Key`;
   * `DevEmailSender` ігнорує — йому нема з ким домовлятися про дедуплікацію.
   *
   * Не гарантія exactly-once сама собою: провайдер лише МОЖЕ розпізнати
   * повторний виклик із тим самим ключем і не надіслати вдруге, у межах свого
   * вікна дедуплікації (у Resend — 24 години). `AuthService` цей ключ не
   * передає — його листи не йдуть через чергу з ретраями й "другого виклику"
   * там немає.
   */
  idempotencyKey?: string
  /**
   * Stage 10 (10g, Q4): true means the raw `to` must not outlive this call — no dev
   * outbox entry, no log line with the address, whatever the implementation would
   * otherwise keep. Set only by the guest-invitation path
   * (`InvitationsService.createGuestEmail`); every other caller omits it, and
   * `DevEmailSender` keeps today's outbox/log behaviour for them unchanged.
   * `ResendEmailSender` ignores it — a real provider call never reaches guest
   * invitations in the first place (see `InvitationsService.createGuestEmail`).
   */
  redactRecipient?: boolean
  /**
   * Stage 10 (10i.2, D2): лист гостьового підтвердження, що несе одноразовий секрет (токен посилання чи
   * шестизначний код) на синтетичну адресу гостя. Ні адреса, ні тіло не потрапляють у лог і в звичайний
   * `outbox`; `DevEmailSender` тримає такий лист в окремому обмеженому сховищі, доступному лише
   * тестові через `sealedTo(email)` (ключ — геш адреси, сама адреса в пам'яті не лежить).
   * Реальний провайдер такий лист приймати не смів би: `ResendEmailSender` його відхиляє.
   */
  sealed?: boolean
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

/** DI-токен: інтерфейс TypeScript не існує в рантаймі, тож інжектимо за рядком. */
export const EMAIL_SENDER = 'EMAIL_SENDER'
