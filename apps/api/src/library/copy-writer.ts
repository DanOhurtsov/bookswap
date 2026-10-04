import { Injectable } from '@nestjs/common'
import { strictestVisibility } from '../access/visibility'
import { WITH_CATALOG } from './library-includes'
import type { Visibility } from '../generated/prisma/enums'
import type { PrismaService } from '../prisma/prisma.service'

/**
 * Єдине місце, де народжується `Copy` власника (docs/plan/fast-book-add.md, §5.1).
 *
 * Спільне для `POST /me/library` і `POST /me/library/quick-add`: два входи, які
 * по-різному вирішують «яка видимість у нового примірника», розійшлися б при
 * першій же зміні правила. Працює і з `PrismaService`, і з транзакційним клієнтом.
 */
export type CopyWriteClient = Pick<PrismaService, 'copy' | 'user'>

export interface NewCopyValues {
  condition?: 'NEW' | 'GOOD' | 'WORN' | 'DAMAGED'
  note?: string | null
  visibility?: Visibility
  acquiredAt?: string | null
}

/**
 * Видимість нового примірника, коли користувач її не задав: не відкритіша за `FRIENDS`.
 *
 * `PRIVATE`-бібліотека дає `PRIVATE`, `FRIENDS` — `FRIENDS`, `PUBLIC` — теж `FRIENDS`:
 * нова книжка не стає публічнішою, ніж була до цієї зміни. Ефективну видимість
 * (найсуворіше з бібліотеки й примірника, §9) це не змінює — її рахує `copyVisibleTo`.
 */
export function defaultCopyVisibility(libraryVisibility: Visibility): Visibility {
  return strictestVisibility(libraryVisibility, 'FRIENDS')
}

/** Дата без часу — опівночі UTC, щоб день не «поїхав» на межі часових поясів. */
export function toDate(value: string | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(`${value}T00:00:00.000Z`)
}

/**
 * Створює примірник вдома: `currentHolderId = ownerId` (інваріант §5.3.2 виконано від
 * народження). Власник — завжди аргумент із сесії, а не частина запиту.
 *
 * Профіль читається тим самим клієнтом (у транзакції — тією самою транзакцією), тож
 * дефолт видимості не може відстати від налаштувань, змінених між запитами.
 *
 * Клас, а не вільна функція, щоб e2e-тест міг підмінити ЄДИНУ точку запису `Copy` і довести
 * відкат усього ланцюга транзакції (`createTestApp({ configure })`).
 */
@Injectable()
export class CopyWriter {
  async create(
    client: CopyWriteClient,
    input: { ownerId: string; editionId: string; values: NewCopyValues },
  ) {
    const { ownerId, editionId, values } = input
    let visibility = values.visibility

    if (visibility === undefined) {
      const owner = await client.user.findUniqueOrThrow({
        where: { id: ownerId },
        select: { libraryVisibility: true },
      })

      visibility = defaultCopyVisibility(owner.libraryVisibility)
    }

    return client.copy.create({
      data: {
        editionId,
        ownerId,
        currentHolderId: ownerId,
        condition: values.condition ?? 'GOOD',
        note: values.note ?? null,
        visibility,
        acquiredAt: toDate(values.acquiredAt),
      },
      include: WITH_CATALOG,
    })
  }
}
