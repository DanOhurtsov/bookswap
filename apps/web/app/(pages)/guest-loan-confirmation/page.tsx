import { GuestLoanResponse } from '@/features/guest-loans/index.client'

/**
 * Stage 10 (10i.3): публічна сторінка гостя без акаунта. Жодної сесії не читає й не потребує;
 * при вимкненому `GUEST_LOANS_ENABLED` сервер віддає 403 `FEATURE_DISABLED` на першому ж запиті,
 * і сторінка показує «Сторінку не знайдено» без жодного кроку потоку.
 */
export default function GuestLoanConfirmationPage() {
  return <GuestLoanResponse />
}
