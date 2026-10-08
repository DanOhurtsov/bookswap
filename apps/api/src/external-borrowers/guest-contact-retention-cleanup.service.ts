import { Injectable, Logger } from '@nestjs/common'
import { EXCLUSIVE_LOAN_STATUS } from '@bookswap/shared'
import { Prisma } from '../generated/prisma/client'
import { PrismaService } from '../prisma/prisma.service'
import { recomputeRetainUntil } from './retention'

/** T7 (§6.11 execution plan, пропозиція): розмір пачки для обох фаз. */
const BATCH_SIZE = 200

const EXCLUSIVE_STATUSES: readonly string[] = EXCLUSIVE_LOAN_STATUS

export interface RetentionCleanupSummary {
  /** Контактів, чий `retainUntil` перераховано з `NULL` (легасі 10f.2/10f.3/10g, або пропущені). */
  backfilled: number
  /** Контактів, видалених разом з alias (`retainUntil <= now`). */
  deleted: number
}

/**
 * Stage 10 (10h, Q1 §0.9 execution plan): retention-чистка гостьових контактів (D3).
 *
 * Виконавець — ЗОВНІШНІЙ scheduler, який щодня запускає CLI-команду
 * (`guest-contact-retention-cleanup.ts`), а не інтервальний сервіс у процесі API — Q1 явно
 * зняла попередню рекомендацію (варіант (a), за зразком `SessionCleanupService`). Тому цей
 * сервіс НЕ реалізує `OnModuleInit`, не має таймера й НЕ підключений ні до `AppModule`, ні до
 * `ExternalBorrowersModule` — лише до окремого `GuestContactRetentionCliModule` (той самий
 * принцип ізоляції, що вже в `MergeService`/`MergeCliModule`, `apps/api/src/cli/merge-cli.module.ts`).
 * `run()` лишається публічним і детермінованим (`now` — параметр) для тестів.
 *
 * Дві фази, обидві ідемпотентні, обидві пачками з `FOR UPDATE SKIP LOCKED` (T7):
 *
 * 1. **Backfill.** Контакти з `retainUntil IS NULL` (створені до появи цього перерахунку в
 *    10f.2/10f.3/10g, або з будь-якої іншої причини пропущені транзакційним перерахунком) —
 *    перераховуються за тією самою формулою (`recomputeRetainUntil`, §0.9), що й переходи
 *    `GuestLoanService`. Жодної вигаданої дати: лише читання вже наявних `Loan`/`LoanEvent`.
 * 2. **Cleanup.** Контакти з `retainUntil <= now` видаляються (`ExternalBorrower`, включно з
 *    alias); `Loan`/`LoanEvent` лишаються без контакту (FK `SET NULL`), `borrowerKind` лишається
 *    `GUEST`.
 *
 * Backfill іде ПЕРЕД cleanup у тому самому проході: якщо щойно перерахований `retainUntil`
 * контакту вже в минулому (наприклад, стара позика повернута 200 днів тому, а `retainUntil` за
 * 10h просто ще ніколи не рахувався), він стає кандидатом на видалення в цьому ж самому запуску
 * — «момент допустимості» вже настав, чекати ще одного проходу не потрібно.
 *
 * Не залежить від `GUEST_LOANS_ENABLED` (T9, §7.3): цей прапорець вимикає лише HTTP-гостьові
 * ендпоінти (`GuestLoansEnabledGuard`), а не існування вже записаних контактів — вимкнена
 * функція не повинна зупиняти видалення того, що вже назбиралося.
 */
@Injectable()
export class GuestContactRetentionCleanupService {
  private readonly logger = new Logger(GuestContactRetentionCleanupService.name)

  constructor(private readonly prisma: PrismaService) {}

  async run(now: Date = new Date()): Promise<RetentionCleanupSummary> {
    const backfilled = await this.backfillPhase()
    const deleted = await this.cleanupPhase(now)

    if (backfilled > 0) {
      this.logger.log(`Перераховано retainUntil для контактів: ${String(backfilled)}`)
    }

    if (deleted > 0) {
      this.logger.log(`Видалено гостьових контактів (D3): ${String(deleted)}`)
    }

    return { backfilled, deleted }
  }

  /**
   * Keyset-пагінація за `id`, а НЕ повторний `WHERE retainUntil IS NULL` з нуля щоразу: контакт з
   * активною позикою (§0.9: активна позика → `retainUntil = NULL` — законний, стабільний
   * результат) інакше збігався б із цим фільтром щоразу знову ПІСЛЯ власного ж перерахунку —
   * нескінченний цикл у межах одного запуску `run()`. Курсор гарантує рівно один прохід по кожному
   * `id` за виклик, незалежно від того, яким лишився його `retainUntil` після перерахунку.
   */
  private async backfillPhase(): Promise<number> {
    let total = 0
    let cursor: string | undefined

    for (;;) {
      const processed = await this.prisma.$transaction(async (tx) => {
        const batch =
          cursor === undefined
            ? await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "ExternalBorrower"
                WHERE "retainUntil" IS NULL
                ORDER BY "id"
                FOR UPDATE SKIP LOCKED
                LIMIT ${BATCH_SIZE}
              `
            : await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "ExternalBorrower"
                WHERE "retainUntil" IS NULL AND "id" > ${cursor}
                ORDER BY "id"
                FOR UPDATE SKIP LOCKED
                LIMIT ${BATCH_SIZE}
              `

        for (const row of batch) {
          await recomputeRetainUntil(tx, row.id)
        }

        return batch
      })

      total += processed.length

      if (processed.length < BATCH_SIZE) break

      cursor = processed[processed.length - 1]!.id
    }

    return total
  }

  /**
   * §6.11.2 execution plan: той самий глобальний порядок локів, що й ручний
   * `ExternalBorrowersService.delete` — `ExternalBorrower → Copy → Loan`, `ORDER BY "id"` для
   * кількох рядків, перечитування ПІСЛЯ будь-якого можливого очікування, рішення на свіжому
   * стані. Раніше ця фаза locувала лише `ExternalBorrower` і покладалася на неявний `ON DELETE
   * SET NULL` для `Copy`/`Loan` — коректно щодо атомарності (Postgres застосовує FK-дію в тій
   * самій транзакції), але не узгоджено з таблицею локів: `Copy` тут може незалежно locати
   * `archiveCopy`/`restoreCopy`/`removeCopy` (вони ніколи не торкаються `ExternalBorrower`,
   * таблиця §6.11.2 без змін) — тож саме явний лок `Copy`, а не FK-дія «за кулісами», дає точку,
   * після якої видно, чи справді нічого не змінилося.
   *
   * Курсор (keyset-пагінація за `id`, той самий прийом, що в `backfillPhase`) — не повторний
   * `WHERE retainUntil <= now` з нуля щоразу: контакт, чия фінальна перевірка (крок 4) відхилила
   * видалення цього разу (гіпотетично — кешований `retainUntil` розійшовся з фактичною активною
   * позикою), інакше знову збігався б із тим самим фільтром на наступній ітерації — нескінченний
   * цикл у межах одного `run()`. Видалені рядки й так зникають із результатів наступних SELECT-ів
   * самі по собі; курсор потрібен саме для рядків, які пройшли крок 1, але НЕ видалені кроком 4.
   */
  private async cleanupPhase(now: Date): Promise<number> {
    let total = 0
    let cursor: string | undefined

    for (;;) {
      const { selected, deleted, lastId } = await this.prisma.$transaction(async (tx) => {
        // 1. ExternalBorrower — перший ресурс (§6.11.2), SKIP LOCKED пачками (T7).
        const batch =
          cursor === undefined
            ? await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "ExternalBorrower"
                WHERE "retainUntil" <= ${now}
                ORDER BY "id"
                FOR UPDATE SKIP LOCKED
                LIMIT ${BATCH_SIZE}
              `
            : await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "ExternalBorrower"
                WHERE "retainUntil" <= ${now} AND "id" > ${cursor}
                ORDER BY "id"
                FOR UPDATE SKIP LOCKED
                LIMIT ${BATCH_SIZE}
              `

        if (batch.length === 0) return { selected: 0, deleted: 0, lastId: cursor }

        const ids = batch.map((row) => row.id)

        // 2. Copy — другий ресурс. Той самий явний лок, що `ExternalBorrowersService.delete`:
        //    усі рядки, яких за секунду до цього торкнеться `ON DELETE SET NULL`, locаються
        //    заздалегідь, `ORDER BY "id"` — детермінований порядок для кількох рядків одразу
        //    кількох контактів у пачці.
        await tx.$queryRaw`
          SELECT "id" FROM "Copy"
          WHERE "heldByContactId" IN (${Prisma.join(ids)})
          ORDER BY "id" FOR UPDATE
        `

        // 3. Loan — третій ресурс. Локується РАЗОМ із читанням `status`/`borrowerContactId`:
        //    друга, незалежна від кешованого `retainUntil` лінія оборони на «немає активної
        //    позики» (той самий `EXCLUSIVE_LOAN_STATUS`, що й у ручному `delete`).
        const loans = await tx.$queryRaw<{ status: string; borrowerContactId: string }[]>`
          SELECT "status", "borrowerContactId" FROM "Loan"
          WHERE "borrowerContactId" IN (${Prisma.join(ids)})
          ORDER BY "id" FOR UPDATE
        `
        // 3b. GuestLoanConfirmation — четвертий ресурс (10i.1): `DELETE` контакту записує в ці рядки
        //     (FK `SET NULL`), тож вони locаються тут, після `Loan`, у детермінованому порядку.
        await tx.$queryRaw`
          SELECT "id" FROM "GuestLoanConfirmation"
          WHERE "externalBorrowerId" IN (${Prisma.join(ids)})
          ORDER BY "id" FOR UPDATE
        `

        const activeContactIds = new Set(
          loans
            .filter((loan) => EXCLUSIVE_STATUSES.includes(loan.status))
            .map((loan) => loan.borrowerContactId),
        )

        // 4. Перечитування ПІСЛЯ локів на Copy/Loan — фінальне рішення на свіжому стані, не на
        //    знімку з кроку 1. `retainUntil` читається ЗНОВУ (не переносить значення з кроку 1);
        //    активна позика виключає контакт навіть якщо кешований `retainUntil` чомусь каже
        //    інше (defence-in-depth, той самий принцип, що вже в `requireGuestRow`).
        const fresh = await tx.externalBorrower.findMany({
          where: { id: { in: ids }, retainUntil: { lte: now } },
          select: { id: true },
        })
        const dueIds = fresh.map((row) => row.id).filter((id) => !activeContactIds.has(id))

        if (dueIds.length > 0) {
          // FK `Loan.borrowerContactId`/`Copy.heldByContactId` → `SET NULL` (schema.prisma):
          // `Loan`/`LoanEvent` лишаються, лише посилання на контакт зникає. Обидва рядки вже
          // явно заблоковані кроками 2–3 — сам DELETE нового локу не бере.
          await tx.externalBorrower.deleteMany({ where: { id: { in: dueIds } } })
        }

        return { selected: batch.length, deleted: dueIds.length, lastId: ids[ids.length - 1] }
      })

      total += deleted

      if (selected < BATCH_SIZE) break

      // Курсор рухається за ВСІМА відібраними id кроку 1, незалежно від того, скільки з них
      // справді видалено кроком 4 — інакше рядок, який крок 4 відхилив (лишився в таблиці),
      // збігався б із тим самим фільтром на наступній ітерації знову.
      cursor = lastId
    }

    return total
  }
}
