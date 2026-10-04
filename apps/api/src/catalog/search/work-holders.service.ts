import { Injectable } from '@nestjs/common'
import type {
  WorkHolderGroup,
  WorkHoldersResponse,
  WORK_HOLDERS_AVAILABILITY,
} from '@bookswap/shared'
import { AnalyticsService } from '../../analytics/analytics.service'
import { groupByOwner, NetworkInventory, type InventoryCopy } from './network-inventory.service'

const KIND_ORDER = { ORIGINAL: 0, TRANSLATION: 1, UNKNOWN: 2 } as const

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
      // `original` — саме видання-оригінал; `UNKNOWN` (текст невідомий) оригіналом не вважається.
      ...(query.translationId === ORIGINAL_TRANSLATION_ID
        ? { translation: 'ORIGINAL' as const }
        : { translationId: query.translationId }),
    })
    const friends = items.filter((item) => item.relation === 'FRIEND')
    // Група — це переклад, а коли зв'язку немає, то тип тексту й мова: оригінал, переклад без даних
    // про перекладача й видання з невідомим текстом — різні групи.
    const groupsByKey = new Map<string, InventoryCopy[]>()

    for (const item of friends) {
      const key = item.copy.translationId ?? `${item.textKind}:${item.language ?? ''}`
      const list = groupsByKey.get(key)

      if (list === undefined) groupsByKey.set(key, [item])
      else list.push(item)
    }

    const groups: WorkHolderGroup[] = [...groupsByKey.values()].flatMap((list) => {
      const [first] = list

      if (first === undefined) return []

      return [
        {
          translationId: first.copy.translationId,
          textKind: first.textKind,
          language: first.language,
          translator: first.translator,
          owners: groupByOwner(list),
        },
      ]
    })

    // Оригінал першим, потім переклади, невідомий текст — наприкінці; далі за мовою й перекладачем —
    // порядок не залежить від бази.
    groups.sort(
      (left, right) =>
        KIND_ORDER[left.textKind] - KIND_ORDER[right.textKind] ||
        (left.language ?? '').localeCompare(right.language ?? '') ||
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
