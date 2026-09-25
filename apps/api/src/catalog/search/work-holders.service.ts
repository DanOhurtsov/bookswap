import { Injectable } from '@nestjs/common'
import type {
  WorkHolderGroup,
  WorkHoldersResponse,
  WORK_HOLDERS_AVAILABILITY,
} from '@bookswap/shared'
import { AnalyticsService } from '../../analytics/analytics.service'
import { groupByOwner, NetworkInventory, type InventoryCopy } from './network-inventory.service'

/** Значення `translationId`, яким адресується видання мовою оригіналу. */
export const ORIGINAL_TRANSLATION_ID = 'original'

export interface WorkHoldersQuery {
  translationId?: string | undefined
  availability: (typeof WORK_HOLDERS_AVAILABILITY)[number]
}

/**
 * «Хто має цю книжку?» — лише друзі глядача, згруповано за перекладом.
 *
 * Свої примірники тут не показуються: питання про мережу, а не про полицю
 * глядача. Усі рішення про видимість і `canRequest` — у `NetworkInventory`.
 */
@Injectable()
export class WorkHoldersService {
  constructor(
    private readonly inventory: NetworkInventory,
    private readonly analytics: AnalyticsService,
  ) {}

  async holders(
    viewerId: string,
    workId: string,
    query: WorkHoldersQuery,
  ): Promise<WorkHoldersResponse> {
    const items = await this.inventory.load(viewerId, {
      scope: 'CIRCLE',
      availability: query.availability,
      workId,
      translationId:
        query.translationId === undefined
          ? undefined
          : query.translationId === ORIGINAL_TRANSLATION_ID
            ? null
            : query.translationId,
    })
    const friends = items.filter((item) => item.relation === 'FRIEND')
    const byTranslation = new Map<string | null, InventoryCopy[]>()

    for (const item of friends) {
      const key = item.copy.translationId
      const list = byTranslation.get(key)

      if (list === undefined) byTranslation.set(key, [item])
      else list.push(item)
    }

    const groups: WorkHolderGroup[] = [...byTranslation.entries()].map(([translationId, list]) => ({
      translationId,
      language: list[0]?.language ?? '',
      translator: list[0]?.translator ?? null,
      owners: groupByOwner(list),
    }))

    // Оригінал першим, далі за мовою й перекладачем — порядок не залежить від бази.
    groups.sort(
      (left, right) =>
        Number(right.translationId === null) - Number(left.translationId === null) ||
        left.language.localeCompare(right.language) ||
        (left.translator ?? '').localeCompare(right.translator ?? ''),
    )

    // `work_holders_found`: друг з примірником, який можна попросити. Без id твору.
    if (groups.some((group) => group.owners.some((owner) => owner.availableCopies > 0))) {
      await this.analytics.record({
        type: 'WORK_HOLDERS_FOUND',
        subjectUserId: viewerId,
        domainEntityId: new Date().toISOString().slice(0, 10),
        properties: {},
      })
    }

    return { workId, groups }
  }
}
