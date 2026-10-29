'use client'

import { SelectField } from '@/components/Form/FormFields'
import { SwitchRow } from '@/components/ui/switch'
import {
  LOAN_TERM_CHOICES,
  loanTermChoiceOf,
  loanTermDaysOf,
  type ProfileSettingsController,
} from '../model/use-profile-settings'
import { ProfileCard } from './ProfileParts'

const FIELDS = [
  'ownerDueReminders',
  'friendsOfFriendsAccess',
  'loanRequestsPaused',
  'defaultLoanTermDays',
] as const

/** «Налаштування позичання» (PROF-08): each change is saved at once. */
export function LendingSettingsCard({ settings }: { settings: ProfileSettingsController }) {
  const { shown, save, saving } = settings
  const error = settings.errorFor(FIELDS)

  return (
    <ProfileCard aria-labelledby="profile-lending" className="flex flex-col gap-1 px-6 py-5">
      <h2 id="profile-lending" className="m-0 mb-1 text-lg leading-[26px] font-semibold">
        Налаштування позичання
      </h2>

      <div className="flex flex-col divide-y divide-(--line)">
        <SwitchRow
          label="Нагадувати про повернення"
          description="За 3 дні до терміну повернення ваших книжок"
          checked={shown.ownerDueReminders}
          disabled={saving}
          onCheckedChange={(checked) => {
            save({ ownerDueReminders: checked })
          }}
        />
        <SwitchRow
          label="Бібліотека для друзів друзів"
          description="Вони зможуть надсилати запити"
          checked={shown.friendsOfFriendsAccess}
          disabled={saving}
          onCheckedChange={(checked) => {
            save({ friendsOfFriendsAccess: checked })
          }}
        />
        <SwitchRow
          label="Пауза для запитів"
          description="Нові запити тимчасово не приходять"
          checked={shown.loanRequestsPaused}
          disabled={saving}
          onCheckedChange={(checked) => {
            save({ loanRequestsPaused: checked })
          }}
        />
      </div>

      <div className="border-t border-(--line) pt-3">
        <SelectField
          id="profile-loan-term"
          label="Термін за замовчуванням"
          value={loanTermChoiceOf(shown.defaultLoanTermDays)}
          options={LOAN_TERM_CHOICES}
          disabled={saving}
          onValueChange={(choice) => {
            save({ defaultLoanTermDays: loanTermDaysOf(choice) })
          }}
        />
      </div>

      {error !== undefined && (
        <p role="alert" className="mt-2 mb-0 text-sm text-(--error)">
          {error}
        </p>
      )}
    </ProfileCard>
  )
}
