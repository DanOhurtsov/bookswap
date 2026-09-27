import { HttpStatus, Injectable } from '@nestjs/common'
import {
  API_ERROR_CODES,
  type ExternalBorrowerListResponse,
  type ExternalBorrowerResponse,
} from '@bookswap/shared'
import { ApiException } from '../common/api.exception'
import { PrismaService } from '../prisma/prisma.service'
import { toExternalBorrower } from './external-borrower.mapper'

/**
 * Stage 10, крок 10f.2: приватні контакти власника. Кожен запит прив'язаний до
 * `ownerId` із сесії; чужий і відсутній контакт неможливо розрізнити (обидва 404).
 *
 * Alias не логується й не потрапляє в помилки, події чи сповіщення.
 */
@Injectable()
export class ExternalBorrowersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, alias: string): Promise<ExternalBorrowerResponse> {
    const row = await this.prisma.externalBorrower.create({
      data: { ownerId, alias, ownerInformedAt: new Date() },
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
}

function notFound(): ApiException {
  return new ApiException(API_ERROR_CODES.NOT_FOUND, 'Контакт не знайдено', HttpStatus.NOT_FOUND)
}
