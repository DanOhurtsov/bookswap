import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  EXCLUSIVE_LOAN_STATUS,
  type ExternalBorrowerInvitationResponse,
  type ExternalBorrowerListResponse,
  type ExternalBorrowerResponse,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import type { UserModel } from '../generated/prisma/models'
import { InvitationsService } from '../invitations/invitations.service'
import { PrismaService } from '../prisma/prisma.service'
import { toExternalBorrower } from './external-borrower.mapper'
import { RETENTION_NO_LOAN_WINDOW_MS } from './retention'

const EXCLUSIVE_STATUSES: readonly string[] = EXCLUSIVE_LOAN_STATUS

/**
 * Stage 10, крок 10f.2: приватні контакти власника. Кожен запит прив'язаний до
 * `ownerId` із сесії; чужий і відсутній контакт неможливо розрізнити (обидва 404).
 *
 * Alias не логується й не потрапляє в помилки, події чи сповіщення.
 */
@Injectable()
export class ExternalBorrowersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invitations: InvitationsService,
  ) {}

  /**
   * Stage 10 (10h, Q2 §0.9 execution plan): контакт без жодної позики зберігається 90 днів від
   * `createdAt` — `retainUntil` встановлюється одразу, тут, а не лишається `NULL` до першої
   * позики/чистки. `createdAt`/`retainUntil` рахуються від того самого `now`, щоб різниця між
   * ними була рівно 90 днів, без дрейфу від окремого виклику БД `now()`.
   */
  async create(ownerId: string, alias: string): Promise<ExternalBorrowerResponse> {
    const now = new Date()
    const row = await this.prisma.externalBorrower.create({
      data: {
        ownerId,
        alias,
        ownerInformedAt: now,
        createdAt: now,
        retainUntil: new Date(now.getTime() + RETENTION_NO_LOAN_WINDOW_MS),
      },
    })

    return { contact: toExternalBorrower(row) }
  }

  async list(ownerId: string): Promise<ExternalBorrowerListResponse> {
    const rows = await this.prisma.externalBorrower.findMany({
      where: { ownerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })

    return { contacts: rows.map(toExternalBorrower) }
  }

  async updateAlias(ownerId: string, id: string, alias: string): Promise<ExternalBorrowerResponse> {
    const { count } = await this.prisma.externalBorrower.updateMany({
      where: { id, ownerId },
      data: { alias },
    })

    if (count === 0) throw notFound()

    const row = await this.prisma.externalBorrower.findFirst({ where: { id, ownerId } })

    if (row === null) throw notFound()

    return { contact: toExternalBorrower(row) }
  }

  /**
   * Stage 10 (10g, D2): `POST /me/external-borrowers/:id/invitation`. Чужий і відсутній
   * контакт нерозрізненні (той самий `notFound()`, що й `updateAlias`/`delete`) — і
   * саме тому перевірка контакту йде **до** будь-якого запиту до `InvitationsService`:
   * стороння людина не має способу дізнатися навіть про існування чужого контакту,
   * не кажучи вже про запуск ліміту чи відправки листа.
   *
   * Лист не містить alias — `createGuestEmail` про контакт нічого не знає, отримує
   * лише `owner` і `email`.
   */
  async sendInvitation(
    owner: UserModel,
    id: string,
    email: string,
  ): Promise<ExternalBorrowerInvitationResponse> {
    const contact = await this.prisma.externalBorrower.findFirst({
      where: { id, ownerId: owner.id },
      select: { id: true },
    })

    if (contact === null) throw notFound()

    const { invitation } = await this.invitations.createGuestEmail(owner, email)

    return { invitation }
  }

  /**
   * Stage 10 (10f.3, Q3d, §6.11.2 execution plan): дострокова чистка (T7). Глобальний порядок
   * локів `ExternalBorrower → Copy → Loan` — `ExternalBorrower` першим і авторизує (чужий/відсутній
   * контакт зупиняє транзакцію тут, до будь-якого запиту до `Copy`), потім явно й заздалегідь
   * locаються рядки `Copy`, яких за секунду до цього торкнеться `ON DELETE SET NULL`
   * (`schema.prisma:444`), потім усі позики контакту одразу (`ORDER BY "id"` — детермінований
   * порядок для кількох рядків), потім (10i.1) рядки `GuestLoanConfirmation` контакту. Сам `DELETE`
   * далі не бере жодного нового локу: каскад лише записує в уже заблоковані рядки.
   */
  async delete(ownerId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [lockedContact] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ExternalBorrower" WHERE "id" = ${id} AND "ownerId" = ${ownerId} FOR UPDATE
      `

      if (lockedContact === undefined) throw notFound()

      // Рядки, яких торкнеться `Copy.heldByContactId → SET NULL`. Порожній результат — нуль локів,
      // не помилка: контакт міг ніколи не тримати книжку чи вже повернув усі.
      await tx.$queryRaw`
        SELECT "id" FROM "Copy" WHERE "heldByContactId" = ${id} ORDER BY "id" FOR UPDATE
      `

      const loans = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT "id", "status" FROM "Loan" WHERE "borrowerContactId" = ${id} ORDER BY "id" FOR UPDATE
      `

      // Stage 10 (10i.1): GuestLoanConfirmation — ЧЕТВЕРТИЙ ресурс порядку (`ExternalBorrower → Copy →
      // Loan → GuestLoanConfirmation`). `DELETE` контакту записує в ці рядки (FK `SET NULL`), тож їх
      // locаємо заздалегідь у детермінованому порядку, після `Loan` — так само, як `Copy`/`Loan`.
      await tx.$queryRaw`
        SELECT "id" FROM "GuestLoanConfirmation" WHERE "externalBorrowerId" = ${id} ORDER BY "id" FOR UPDATE
      `

      if (loans.some((loan) => EXCLUSIVE_STATUSES.includes(loan.status))) {
        throw new ApiException(
          API_ERROR_CODES.EXTERNAL_BORROWER_HAS_ACTIVE_LOAN,
          'У контакту є активна позика — спершу поверніть книжку або запишіть втрату',
          HttpStatus.CONFLICT,
        )
      }

      const lostLoanIds = loans.filter((loan) => loan.status === 'LOST').map((loan) => loan.id)

      if (lostLoanIds.length > 0) {
        const closures = await tx.loanEvent.findMany({
          where: { loanId: { in: lostLoanIds }, type: { in: ['RECOVERED', 'LOSS_CLOSED'] } },
          select: { loanId: true },
        })
        const closedLoanIds = new Set(closures.map((event) => event.loanId))

        if (lostLoanIds.some((loanId) => !closedLoanIds.has(loanId))) {
          throw new ApiException(
            API_ERROR_CODES.EXTERNAL_BORROWER_HAS_UNRESOLVED_LOSS,
            'У контакту є незакрита втрата — спершу «Знайшлася» або «Закрити втрату»',
            HttpStatus.CONFLICT,
          )
        }
      }

      await tx.externalBorrower.delete({ where: { id } })
    })
  }
}

function notFound(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Контакт не знайдено', HttpStatus.NOT_FOUND)
}
