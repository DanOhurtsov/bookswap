import type { ActivationTimingStat, FunnelReport, FunnelStep } from './funnel-report'

const MINUTE_SECONDS = 60
const HOUR_SECONDS = 60 * MINUTE_SECONDS
const DAY_SECONDS = 24 * HOUR_SECONDS

/**
 * A human reading of the very same second count — not a second metric. It is
 * printed beside the number rather than instead of it, so the text and the JSON
 * stay about one and the same `medianSeconds` value.
 */
function humanizeSeconds(seconds: number): string {
  if (seconds >= DAY_SECONDS) {
    return `${String(Math.floor(seconds / DAY_SECONDS))} дн ${String(Math.floor((seconds % DAY_SECONDS) / HOUR_SECONDS))} год`
  }

  if (seconds >= HOUR_SECONDS) {
    return `${String(Math.floor(seconds / HOUR_SECONDS))} год ${String(Math.floor((seconds % HOUR_SECONDS) / MINUTE_SECONDS))} хв`
  }

  if (seconds >= MINUTE_SECONDS) {
    return `${String(Math.floor(seconds / MINUTE_SECONDS))} хв ${String(seconds % MINUTE_SECONDS)} с`
  }

  return `${String(seconds)} с`
}

/**
 * `sampleSize: 0` prints as «—» rather than «0 с»: an empty sample has no
 * median, and a zero would read as «they got there instantly».
 */
function formatActivationStat(label: string, stat: ActivationTimingStat): string {
  const median =
    stat.medianSeconds === null
      ? '—'
      : `${String(stat.medianSeconds)} с  (${humanizeSeconds(stat.medianSeconds)})`

  return `  ${label.padEnd(16)} median: ${median}   вибірка: ${String(stat.sampleSize)}`
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${String(value)}%`
}

function formatStep(step: FunnelStep): string {
  const prefix = `${String(step.position).padStart(2)}. ${step.label.padEnd(34)}`

  return `${prefix} ${String(step.count).padStart(4)} ${`${String(step.percentage)}%`.padStart(6)}`
}

export function formatFunnelReportText(report: FunnelReport): string {
  if (report.status === 'empty') return report.messages.join('\n')

  const ratio = report.temporaryMetrics.successfulReturnedLoansPerActiveUser

  return [
    `Когорта ${report.cohort.from} – ${report.cohort.to} (реєстрацій: ${String(report.cohort.registrations)}), вікно конверсії: ${String(report.cohort.windowDays)} днів`,
    `Earliest stored analytics event: ${report.earliestStoredAnalyticsEvent}`,
    ...report.warnings,
    '',
    ...report.steps.map(formatStep),
    '',
    'Мережа й discovery (Етап 9, лише агрегати когорти):',
    `  invites: sent ${String(report.network.invites.sent)}, accepted ${String(report.network.invites.accepted)}, acceptance ${formatPercent(report.network.invites.acceptancePercent)}`,
    `  search → found: ${String(report.network.discovery.foundUsers)} / ${String(report.network.discovery.searchedUsers)} користувачів, ${formatPercent(report.network.discovery.searchToFoundPercent)}`,
    `  found → request: ${String(report.network.discovery.foundThenRequestedUsers)} / ${String(report.network.discovery.foundAnyUsers)} користувачів, ${formatPercent(report.network.discovery.foundToRequestPercent)}`,
    '',
    'Тимчасові метрики (до Circle/network entity, Stage 14):',
    `  successful returned loans, total: ${String(report.temporaryMetrics.successfulReturnedLoansTotal)}`,
    `  successful returned loans, per active user: ${ratio === null ? '—' : ratio.toFixed(2)}  (active users: ${String(report.temporaryMetrics.activeUsers)})`,
    '',
    'BOOK_ADDED за методом (той самий період, що й cross-check):',
    `  MANUAL: ${String(report.bookAddedByMethod.MANUAL)}`,
    `  BARCODE: ${String(report.bookAddedByMethod.BARCODE)}`,
    `  CSV: ${String(report.bookAddedByMethod.CSV)}`,
    `  invalidProperties: ${String(report.bookAddedByMethod.invalidProperties)}`,
    '',
    'Activation timing (від signup, те саме вікно конверсії):',
    formatActivationStat('до 1-ї книги', report.activationTiming.firstBook),
    formatActivationStat('до 10-ї книги', report.activationTiming.tenthBook),
    '',
    'Cross-check із доменними таблицями (діагностичний, не funnel):',
    '  BOOK_ADDED (events) vs Copy.createdAt (domain), той самий період:',
    `    event-only: ${String(report.crossCheck.bookAdded.eventOnly)}   domain-only: ${String(report.crossCheck.bookAdded.domainOnly)}`,
  ].join('\n')
}

export function formatFunnelReportJson(report: FunnelReport): string {
  return JSON.stringify(report, null, 2)
}
