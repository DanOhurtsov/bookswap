import { PagedSearchQueryDto } from '../../dto/paged-search-query.dto'

/**
 * Той самий вхід, що й у `/catalog/search` (§6.3, крок 2): назва або ISBN в
 * одному полі плюс `page`/`pageSize`. Успадковано, а не повторено: майстер і
 * `/catalog` гортають один список, і розбіжність у тому, що приймає кожен,
 * означала б 400 для адреси, яку сусідній ендпоінт приймає. Без `page` і
 * `pageSize` — перший екран, який кличе перевірка дублікатів.
 */
export class SearchCandidatesQueryDto extends PagedSearchQueryDto {}
