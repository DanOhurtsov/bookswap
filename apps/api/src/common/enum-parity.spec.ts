import {
  AUTHOR_ROLE,
  CATALOG_ENTITY_TYPE,
  CHANNEL,
  CONDITION,
  COPY_STATUS,
  DELIVERY_STATUS,
  DIGEST_NOTIFICATION_TYPE,
  EDITION_FORMAT,
  EXCLUSIVE_LOAN_STATUS,
  FRIENDSHIP_STATUS,
  IMMEDIATE_NOTIFICATION_TYPE,
  LIBRARY_IMPORT_ROW_STATUS,
  LIBRARY_IMPORT_STATUS,
  LOAN_STATUS,
  NOTIFICATION_TYPE,
  OPEN_LOAN_STATUS,
  OWNER_COPY_STATUS,
  PREFERENCE_CHANNEL,
  VISIBILITY,
} from '@bookswap/shared'
import type {
  AuthorRole as SharedAuthorRole,
  CatalogEntityType as SharedCatalogEntityType,
  Channel as SharedChannel,
  Condition as SharedCondition,
  CopyStatus as SharedCopyStatus,
  DeliveryStatus as SharedDeliveryStatus,
  EditionFormat as SharedEditionFormat,
  FriendshipStatus as SharedFriendshipStatus,
  LibraryImportRowStatus as SharedLibraryImportRowStatus,
  LibraryImportStatus as SharedLibraryImportStatus,
  LoanStatus as SharedLoanStatus,
  NotificationType as SharedNotificationType,
  Visibility as SharedVisibility,
} from '@bookswap/shared'
import {
  AuthorRole as PrismaAuthorRole,
  CatalogEntityType as PrismaCatalogEntityType,
  Channel as PrismaChannel,
  Condition as PrismaCondition,
  CopyStatus as PrismaCopyStatus,
  DeliveryStatus as PrismaDeliveryStatus,
  EditionFormat as PrismaEditionFormat,
  FriendshipStatus as PrismaFriendshipStatus,
  LibraryImportRowStatus as PrismaLibraryImportRowStatus,
  LibraryImportStatus as PrismaLibraryImportStatus,
  LoanStatus as PrismaLoanStatus,
  NotificationType as PrismaNotificationType,
  Visibility as PrismaVisibility,
} from '../generated/prisma/enums'
import type {
  AuthorRole as PrismaAuthorRoleType,
  CatalogEntityType as PrismaCatalogEntityTypeType,
  Channel as PrismaChannelType,
  Condition as PrismaConditionType,
  CopyStatus as PrismaCopyStatusType,
  DeliveryStatus as PrismaDeliveryStatusType,
  EditionFormat as PrismaEditionFormatType,
  FriendshipStatus as PrismaFriendshipStatusType,
  LibraryImportRowStatus as PrismaLibraryImportRowStatusType,
  LibraryImportStatus as PrismaLibraryImportStatusType,
  LoanStatus as PrismaLoanStatusType,
  NotificationType as PrismaNotificationTypeType,
  Visibility as PrismaVisibilityType,
} from '../generated/prisma/enums'

/**
 * `packages/shared` не має права імпортувати згенерований Prisma Client (§12.1),
 * тож значення enum'ів описані там окремо. Це єдина точка, де можливий розсинхрон
 * між доменом і контрактом, — і вона перевіряється тут, з обох боків.
 */

/** Компіляційна перевірка: типи взаємно присвоювані, тобто множини значень збігаються. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const _visibilityMatches: Equal<SharedVisibility, PrismaVisibilityType> = true
const _friendshipStatusMatches: Equal<SharedFriendshipStatus, PrismaFriendshipStatusType> = true
const _authorRoleMatches: Equal<SharedAuthorRole, PrismaAuthorRoleType> = true
const _editionFormatMatches: Equal<SharedEditionFormat, PrismaEditionFormatType> = true
const _copyStatusMatches: Equal<SharedCopyStatus, PrismaCopyStatusType> = true
const _conditionMatches: Equal<SharedCondition, PrismaConditionType> = true
const _loanStatusMatches: Equal<SharedLoanStatus, PrismaLoanStatusType> = true
const _notificationTypeMatches: Equal<SharedNotificationType, PrismaNotificationTypeType> = true
const _channelMatches: Equal<SharedChannel, PrismaChannelType> = true
const _deliveryStatusMatches: Equal<SharedDeliveryStatus, PrismaDeliveryStatusType> = true
const _catalogEntityTypeMatches: Equal<SharedCatalogEntityType, PrismaCatalogEntityTypeType> = true
const _libraryImportStatusMatches: Equal<SharedLibraryImportStatus, PrismaLibraryImportStatusType> =
  true
const _libraryImportRowStatusMatches: Equal<
  SharedLibraryImportRowStatus,
  PrismaLibraryImportRowStatusType
> = true

describe('Visibility: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...VISIBILITY].sort()).toEqual(Object.values(PrismaVisibility).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_visibilityMatches).toBe(true)
  })

  it('відповідає §4.2', () => {
    expect([...VISIBILITY].sort()).toEqual(['FRIENDS', 'PRIVATE', 'PUBLIC'])
  })
})

describe('FriendshipStatus: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...FRIENDSHIP_STATUS].sort()).toEqual(Object.values(PrismaFriendshipStatus).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_friendshipStatusMatches).toBe(true)
  })

  it('відповідає §4.3', () => {
    expect([...FRIENDSHIP_STATUS].sort()).toEqual(['ACCEPTED', 'BLOCKED', 'DECLINED', 'PENDING'])
  })
})

describe('AuthorRole: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...AUTHOR_ROLE].sort()).toEqual(Object.values(PrismaAuthorRole).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_authorRoleMatches).toBe(true)
  })

  it('відповідає §4.4', () => {
    expect([...AUTHOR_ROLE].sort()).toEqual(['AUTHOR', 'CO_AUTHOR', 'EDITOR', 'ILLUSTRATOR'])
  })
})

describe('EditionFormat: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...EDITION_FORMAT].sort()).toEqual(Object.values(PrismaEditionFormat).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_editionFormatMatches).toBe(true)
  })

  it('відповідає §4.4', () => {
    expect([...EDITION_FORMAT].sort()).toEqual(['HARDCOVER', 'PAPERBACK', 'POCKET'])
  })
})

describe('CopyStatus: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...COPY_STATUS].sort()).toEqual(Object.values(PrismaCopyStatus).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_copyStatusMatches).toBe(true)
  })

  it('відповідає §4.5', () => {
    expect([...COPY_STATUS].sort()).toEqual(['AVAILABLE', 'LENT_OUT', 'RESERVED', 'UNAVAILABLE'])
  })

  /**
   * `OWNER_COPY_STATUS` навмисно **не** дзеркалить Prisma-enum: це не «які стани
   * бувають», а «що власник має право проставити руками». `RESERVED` і
   * `LENT_OUT` виникають лише з переходів §5.1, тож у контракті редагування
   * примірника їх немає — і саме це тут зафіксовано, щоб їх туди не додали.
   */
  it('власнику доступні лише AVAILABLE і UNAVAILABLE (§5.1)', () => {
    expect([...OWNER_COPY_STATUS].sort()).toEqual(['AVAILABLE', 'UNAVAILABLE'])

    for (const status of OWNER_COPY_STATUS) {
      expect(Object.values(PrismaCopyStatus)).toContain(status)
    }
  })
})

describe('Condition: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...CONDITION].sort()).toEqual(Object.values(PrismaCondition).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_conditionMatches).toBe(true)
  })

  it('відповідає §4.5', () => {
    expect([...CONDITION].sort()).toEqual(['DAMAGED', 'GOOD', 'NEW', 'WORN'])
  })
})

describe('LoanStatus: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...LOAN_STATUS].sort()).toEqual(Object.values(PrismaLoanStatus).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_loanStatusMatches).toBe(true)
  })

  it('відповідає §4.6', () => {
    expect([...LOAN_STATUS].sort()).toEqual([
      'APPROVED',
      'CANCELLED',
      'HANDED_OVER',
      'LOST',
      'REJECTED',
      'REQUESTED',
      'RETURNED',
    ])
  })

  /**
   * §5.2: «`OVERDUE` — не статус». Прострочення виводиться як
   * `status = HANDED_OVER AND dueAt < now()`. Окремий статус довелося б проставляти
   * по крону, і він завжди відставав би — тому його немає ні в Prisma, ні в shared,
   * і тест стежить, щоб не зʼявився.
   */
  it('OVERDUE немає — це похідний прапорець, а не статус', () => {
    expect([...LOAN_STATUS]).not.toContain('OVERDUE')
    expect(Object.values(PrismaLoanStatus)).not.toContain('OVERDUE')
  })

  /**
   * Ці два списки — не дзеркала Prisma-enum, а відповіді на інші питання:
   * «чи є щось незавершене» і «чи займає книжку ексклюзивно». Другий мусить
   * збігатися з множиною часткового унікального індексу §5.3.1.
   */
  it('незавершені й ексклюзивні статуси лишаються підмножинами §4.6', () => {
    expect([...OPEN_LOAN_STATUS].sort()).toEqual(['APPROVED', 'HANDED_OVER', 'REQUESTED'])
    expect([...EXCLUSIVE_LOAN_STATUS].sort()).toEqual(['APPROVED', 'HANDED_OVER'])

    for (const status of OPEN_LOAN_STATUS) {
      expect(Object.values(PrismaLoanStatus)).toContain(status)
    }
  })

  it('ексклюзивні — саме ті, що тримає one_active_loan_per_copy (§5.3.1)', () => {
    for (const status of EXCLUSIVE_LOAN_STATUS) {
      expect(OPEN_LOAN_STATUS).toContain(status)
    }

    expect([...EXCLUSIVE_LOAN_STATUS]).not.toContain('REQUESTED')
  })
})

describe('NotificationType: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...NOTIFICATION_TYPE].sort()).toEqual(Object.values(PrismaNotificationType).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_notificationTypeMatches).toBe(true)
  })

  it('містить усі типи §4.8', () => {
    for (const type of [
      'LOAN_REQUESTED',
      'LOAN_APPROVED',
      'LOAN_REJECTED',
      'LOAN_HANDED_OVER',
      'LOAN_RETURNED',
      'LOAN_DUE_SOON',
      'LOAN_OVERDUE',
      'FRIEND_REQUESTED',
      'FRIEND_ACCEPTED',
    ]) {
      expect([...NOTIFICATION_TYPE]).toContain(type)
    }
  })

  /**
   * Свідоме доповнення до §4.8: §5.1 для `APPROVED → CANCELLED` вимагає
   * «сповіщення другій стороні», а типу під нього в переліку немає. Деталі — в
   * README; тест фіксує, що доповнення є з обох боків.
   */
  it('LOAN_CANCELLED присутній і в shared, і в Prisma', () => {
    expect([...NOTIFICATION_TYPE]).toContain('LOAN_CANCELLED')
    expect(Object.values(PrismaNotificationType)).toContain('LOAN_CANCELLED')
  })
})

describe('Channel: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...CHANNEL].sort()).toEqual(Object.values(PrismaChannel).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_channelMatches).toBe(true)
  })

  it('відповідає §4.8', () => {
    expect([...CHANNEL].sort()).toEqual(['EMAIL', 'IN_APP', 'TELEGRAM'])
  })

  /**
   * §7.6 покриває **всі** канали §4.8, `IN_APP` включно.
   *
   * Тест стоїть тут, бо спокуса виключити in-app із матриці («він же завжди
   * увімкнений») повертається щоразу, а ціна її — мовчазно відібраний у людини
   * вибір: отримувати сповіщення лише в Telegram і не бачити лічильника
   * непрочитаних.
   */
  it('матриця §7.6 покриває всі канали §4.8, включно з IN_APP', () => {
    expect([...PREFERENCE_CHANNEL].sort()).toEqual(Object.values(PrismaChannel).sort())
    expect([...PREFERENCE_CHANNEL]).toContain('IN_APP')
  })
})

describe('DeliveryStatus: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...DELIVERY_STATUS].sort()).toEqual(Object.values(PrismaDeliveryStatus).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_deliveryStatusMatches).toBe(true)
  })

  it('відповідає §4.8', () => {
    expect([...DELIVERY_STATUS].sort()).toEqual(['FAILED', 'PENDING', 'SENT'])
  })
})

describe('CatalogEntityType: shared ↔ Prisma', () => {
  it('містить ті самі значення', () => {
    expect([...CATALOG_ENTITY_TYPE].sort()).toEqual(Object.values(PrismaCatalogEntityType).sort())
  })

  it('типи взаємно присвоювані', () => {
    expect(_catalogEntityTypeMatches).toBe(true)
  })

  it('відповідає ланцюгу §3: Work, Translation, Edition', () => {
    expect([...CATALOG_ENTITY_TYPE].sort()).toEqual(['EDITION', 'TRANSLATION', 'WORK'])
  })
})

describe('LibraryImportStatus: shared ↔ Prisma (Stage 8f-1, R6)', () => {
  it('has the same values', () => {
    expect([...LIBRARY_IMPORT_STATUS].sort()).toEqual(
      Object.values(PrismaLibraryImportStatus).sort(),
    )
  })

  it('types are mutually assignable', () => {
    expect(_libraryImportStatusMatches).toBe(true)
  })
})

describe('LibraryImportRowStatus: shared ↔ Prisma (Stage 8f-1, R5)', () => {
  it('has the same values', () => {
    expect([...LIBRARY_IMPORT_ROW_STATUS].sort()).toEqual(
      Object.values(PrismaLibraryImportRowStatus).sort(),
    )
  })

  it('types are mutually assignable', () => {
    expect(_libraryImportRowStatusMatches).toBe(true)
  })

  it('matches the five R5 statuses', () => {
    expect([...LIBRARY_IMPORT_ROW_STATUS].sort()).toEqual([
      'INVALID',
      'NEEDS_REVIEW',
      'READY_CREATE_CHAIN',
      'READY_EXISTING_EDITION',
      'SKIPPED',
    ])
  })
})

describe('§7.5: негайно vs дайджест ↔ Prisma', () => {
  /**
   * Розбиття живе в `shared`, а перевірка на повноту — тут, де видно Prisma-enum:
   * новий тип події, доданий у схему й у shared, але забутий в обох списках §7.5,
   * не надсилався б ніколи, і жоден інший тест цього не помітив би.
   */
  it('покриває всі типи Prisma без перетину', () => {
    const immediate = new Set<string>(IMMEDIATE_NOTIFICATION_TYPE)
    const digest = new Set<string>(DIGEST_NOTIFICATION_TYPE)

    for (const type of Object.values(PrismaNotificationType)) {
      expect(immediate.has(type) !== digest.has(type)).toBe(true)
    }

    expect(immediate.size + digest.size).toBe(NOTIFICATION_TYPE.length)
  })
})
