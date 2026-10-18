import {
  PageNumberQueryDto,
  SearchPageSizeField,
  SearchTextField,
} from '../../dto/paged-search-query.dto'

/**
 * Той самий вхід, що й у `/catalog/search` (§6.3, крок 2): назва або ISBN в
 * одному полі плюс `page`/`pageSize`. Поля перевіряються тими самими правилами
 * (`SearchTextField`, `SearchPageSizeField`), а не повтореними: майстер і
 * `/catalog` гортають один список, і розбіжність у тому, що приймає кожен,
 * означала б 400 для адреси, яку сусідній ендпоінт приймає. Без `page` і
 * `pageSize` — перший екран, який кличе перевірка дублікатів.
 */
export class SearchCandidatesQueryDto extends PageNumberQueryDto {
  @SearchTextField()
  q!: string

  /**
   * No default here: an absent size is the duplicate check's own top-N (`SEARCH_CANDIDATES_LIMIT`,
   * resolved by the controller), not the list's default page size — changing how many cards a
   * search page shows must not change how many candidates the check offers. An explicit size is
   * one of the list's.
   */
  @SearchPageSizeField()
  pageSize?: number
}
