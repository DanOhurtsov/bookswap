import type { FunnelReport, FunnelStep } from './funnel-report'

function formatStep(step: FunnelStep): string {
  const prefix = `${String(step.position).padStart(2)}. ${step.label.padEnd(34)}`

  if (step.count === null) return `${prefix}  —    ${step.note}`

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
    'Тимчасові метрики (до Circle/network entity, Stage 9/14):',
    `  successful returned loans, total: ${String(report.temporaryMetrics.successfulReturnedLoansTotal)}`,
    `  successful returned loans, per active user: ${ratio === null ? '—' : ratio.toFixed(2)}  (active users: ${String(report.temporaryMetrics.activeUsers)})`,
    '',
    'BOOK_ADDED за методом (той самий період, що й cross-check):',
    `  MANUAL: ${String(report.bookAddedByMethod.MANUAL)}`,
    `  BARCODE: ${String(report.bookAddedByMethod.BARCODE)}`,
    `  CSV: ${String(report.bookAddedByMethod.CSV)}`,
    `  invalidProperties: ${String(report.bookAddedByMethod.invalidProperties)}`,
    '',
    'Cross-check із доменними таблицями (діагностичний, не funnel):',
    '  BOOK_ADDED (events) vs Copy.createdAt (domain), той самий період:',
    `    event-only: ${String(report.crossCheck.bookAdded.eventOnly)}   domain-only: ${String(report.crossCheck.bookAdded.domainOnly)}`,
  ].join('\n')
}

export function formatFunnelReportJson(report: FunnelReport): string {
  return JSON.stringify(report, null, 2)
}
