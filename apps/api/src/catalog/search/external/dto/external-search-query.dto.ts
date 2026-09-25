import { PagedSearchQueryDto } from '../../../dto/paged-search-query.dto'

/**
 * The same input as `/catalog/search`: one "title or ISBN" field and one page
 * number. Inherited rather than repeated on purpose — both requests come from
 * ONE form and ONE set of page controls, and a divergence would mean the local
 * search accepts an address the external one rejects with a 400, leaving half a
 * list on screen.
 *
 * Validated in the DTO rather than in the service, same as `LookupQueryDto`: a
 * too-short query or a malformed page must answer 400 BEFORE any external call.
 */
export class ExternalSearchQueryDto extends PagedSearchQueryDto {}
