import type { ReliabilityView } from '../model/profile-view'
import { ProfileCard } from './ProfileParts'

/** «Надійність»: how I return books as a borrower (PO decision, 26.10.2026). */
export function ReliabilityCard({ reliability }: { reliability: ReliabilityView }) {
  const { onTime, averageLoan, outNow } = reliability

  return (
    <ProfileCard aria-labelledby="profile-trust" className="flex flex-col gap-3.5 p-6">
      <h2 id="profile-trust" className="m-0 text-lg leading-[26px] font-semibold">
        Надійність
      </h2>

      {onTime === null ? (
        <p className="m-0 text-sm leading-5 text-(--bookswap-muted)">
          Ще немає повернених позик із терміном.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between text-[15px] leading-[22px]">
            <span>Повертає вчасно</span>
            <span className="font-bold">{onTime.text}</span>
          </div>
          <div
            role="img"
            aria-label={onTime.ariaLabel}
            className="h-2 overflow-hidden rounded-full bg-(--line)"
          >
            <div
              className="h-full rounded-full bg-(--bookswap-accent)"
              style={{ width: `${String(onTime.percent)}%` }}
            />
          </div>
        </div>
      )}

      <dl className="m-0 flex flex-col gap-2 text-sm leading-5">
        {averageLoan !== null && (
          <div className="flex justify-between gap-3">
            <dt className="text-(--bookswap-muted)">Середній термін позики</dt>
            <dd className="m-0 font-semibold">{averageLoan}</dd>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <dt className="text-(--bookswap-muted)">Зараз у друзів</dt>
          <dd className="m-0 font-semibold">{outNow}</dd>
        </div>
      </dl>
    </ProfileCard>
  )
}
