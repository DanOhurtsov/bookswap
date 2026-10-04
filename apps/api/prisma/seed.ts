import { resolve } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { PrismaPg } from '@prisma/adapter-pg'
import { normalizeSearchText } from '../src/catalog/search-text'
import { PrismaClient } from '../src/generated/prisma/client'
import {
  AuthorRole,
  Condition,
  EditionFormat,
  EditionTextKind,
  FriendshipStatus,
} from '../src/generated/prisma/enums'

/**
 * Наповнення локальної бази демо-даними.
 *
 * Повторюваний: усі id фіксовані, усі записи створюються через `upsert`, тож
 * повторний прогін не плодить рядків і не змінює наявні. Це важливо не лише для
 * зручності — на цьому тримається `pnpm test:db` (див. `test/db/seed.db-spec.ts`).
 *
 * Лоанів тут немає навмисно: створювати їх можна лише через сервісний метод
 * стейт-машини (§5), якого ще не існує. Рядок `Loan`, вставлений повз неї, розійшовся
 * би зі станом `Copy`.
 */

/**
 * §4.3 та інваріант §5.3.5: `userAId < userBId` лексикографічно. Порядок задає
 * сортування id, тому ініціатор запиту зберігається окремо, в `requestedById`.
 *
 * Канонічна реалізація — `normalizePair` у `src/access/friendship.pair.ts`. Тут
 * лишається копія навмисно: seed виконується `tsx` поза Nest і не має тягнути
 * код застосунку. Розходження між ними ловить CHECK `friendship_ab_ordered`.
 */
function friendshipPair(
  requestedById: string,
  otherId: string,
): { userAId: string; userBId: string; requestedById: string } {
  const [userAId, userBId] = [requestedById, otherId].sort()

  // sort() на кортежі з двох елементів завжди дає два елементи; звуження для
  // noUncheckedIndexedAccess.
  if (userAId === undefined || userBId === undefined) {
    throw new Error('Недосяжно: пара друзів завжди має два id')
  }

  return { userAId, userBId, requestedById }
}

/**
 * Плейсхолдер, а не хеш робочого пароля: жоден із seed-користувачів залогінитись
 * не зможе, і це навмисно. Демо-дані існують, щоб на них дивитися запитами й
 * тестами, а не щоб під ними ходити — інакше «увійти як Марта» рано чи пізно
 * зʼявиться в інструкції, а звідти й у проді.
 */
const PLACEHOLDER_PASSWORD_HASH = 'seed-placeholder-no-login'

const USERS = [
  { id: 'seed-user-marta', email: 'marta@example.com', displayName: 'Марта Крук' },
  { id: 'seed-user-oles', email: 'oles@example.com', displayName: 'Олесь Гнатюк' },
  { id: 'seed-user-bohdan', email: 'bohdan@example.com', displayName: 'Богдан Сич' },
  { id: 'seed-user-yaryna', email: 'yaryna@example.com', displayName: 'Ярина Лозова' },
] as const

const AUTHORS = [
  { id: 'seed-author-roberts', name: 'Ґреґорі Девід Робертс', nameLatin: 'Gregory David Roberts' },
  { id: 'seed-author-tolkien', name: 'Джон Рональд Руел Толкін', nameLatin: 'J. R. R. Tolkien' },
  { id: 'seed-author-pidmohylny', name: 'Валер’ян Підмогильний', nameLatin: 'Valerian Pidmohylny' },
] as const

export async function seed(prisma: PrismaClient): Promise<void> {
  // --- Користувачі (§4.2) ---------------------------------------------------
  for (const user of USERS) {
    await prisma.user.upsert({
      where: { id: user.id },
      update: {},
      create: {
        id: user.id,
        email: user.email,
        emailVerified: true,
        passwordHash: PLACEHOLDER_PASSWORD_HASH,
        displayName: user.displayName,
      },
    })
  }

  // --- Дружба (§4.3) --------------------------------------------------------
  // Марта дружить з Олесем і Богданом; Ярина надіслала Марті запит, який ще висить.
  const friendships = [
    { ...friendshipPair('seed-user-marta', 'seed-user-oles'), status: FriendshipStatus.ACCEPTED },
    { ...friendshipPair('seed-user-bohdan', 'seed-user-marta'), status: FriendshipStatus.ACCEPTED },
    { ...friendshipPair('seed-user-yaryna', 'seed-user-marta'), status: FriendshipStatus.PENDING },
  ]

  for (const friendship of friendships) {
    await prisma.friendship.upsert({
      where: { userAId_userBId: { userAId: friendship.userAId, userBId: friendship.userBId } },
      update: {},
      create: {
        ...friendship,
        respondedAt: friendship.status === FriendshipStatus.ACCEPTED ? new Date(0) : null,
      },
    })
  }

  // --- Автори (§4.4) --------------------------------------------------------
  // `nameNorm` і `titleNorm` рахує та сама SQL-функція `bookswap_norm`, що й
  // пошук (§6.3). Тут навмисно немає TS-наближення: воно розійшлося б із
  // постгресівським `unaccent` на першому ж слові з «ї».
  const authorNames = await normalizeSearchText(
    prisma,
    AUTHORS.map((author) => author.name),
  )

  for (const [index, author] of AUTHORS.entries()) {
    const nameNorm = authorNames[index]

    if (nameNorm === undefined) throw new Error(`Не вдалося нормалізувати імʼя: ${author.name}`)

    await prisma.author.upsert({
      where: { id: author.id },
      update: {},
      create: { ...author, nameNorm },
    })
  }

  // --- Твори ----------------------------------------------------------------
  const works = [
    {
      id: 'seed-work-shantaram',
      title: 'Шантарам',
      origLang: 'en',
      firstPubYear: 2003,
      authorId: 'seed-author-roberts',
      createdById: 'seed-user-marta',
    },
    {
      id: 'seed-work-hobbit',
      title: 'Гобіт, або Туди і звідти',
      origLang: 'en',
      firstPubYear: 1937,
      authorId: 'seed-author-tolkien',
      createdById: 'seed-user-oles',
    },
    {
      id: 'seed-work-misto',
      title: 'Місто',
      origLang: 'uk',
      firstPubYear: 1928,
      authorId: 'seed-author-pidmohylny',
      createdById: 'seed-user-bohdan',
    },
  ]

  const workTitles = await normalizeSearchText(
    prisma,
    works.map((work) => work.title),
  )

  for (const [index, work] of works.entries()) {
    const { authorId, ...fields } = work
    const titleNorm = workTitles[index]

    if (titleNorm === undefined) throw new Error(`Не вдалося нормалізувати назву: ${work.title}`)

    await prisma.work.upsert({
      where: { id: work.id },
      update: {},
      create: { ...fields, titleNorm },
    })

    await prisma.workAuthor.upsert({
      where: {
        workId_authorId_role: { workId: work.id, authorId, role: AuthorRole.AUTHOR },
      },
      update: {},
      // Один автор на seed-твір — position завжди 0 (Stage 8e-1, R10a).
      create: { workId: work.id, authorId, role: AuthorRole.AUTHOR, position: 0 },
    })
  }

  // --- Переклади (§4.4) -----------------------------------------------------
  // «Гобіт» навмисно має два переклади одного твору: саме на цій формі даних
  // працюватиме ранг перекладів (§10) і вибір «який брати» (§1).
  // `createdById` — творець твору-батька: seed не моделює окрему сесію, під якою
  // хтось додав переклад пізніше, тож найближчий чесний вибір — той самий
  // користувач, що завів Work (Stage 8e-1, R9).
  const translations = [
    {
      id: 'seed-translation-shantaram-uk',
      workId: 'seed-work-shantaram',
      translator: 'Любов Пилаєва',
      lang: 'uk',
      sourceLang: 'en',
      year: 2017,
      hasNotes: true,
      createdById: 'seed-user-marta',
    },
    {
      id: 'seed-translation-hobbit-mokrovolsky',
      workId: 'seed-work-hobbit',
      translator: 'Олександр Мокровольський',
      lang: 'uk',
      sourceLang: 'en',
      year: 1985,
      isAbridged: true,
      createdById: 'seed-user-oles',
    },
    {
      id: 'seed-translation-hobbit-oniryshkevych',
      workId: 'seed-work-hobbit',
      translator: 'Олена Оніщук',
      lang: 'uk',
      sourceLang: 'en',
      year: 2007,
      hasNotes: true,
      createdById: 'seed-user-oles',
    },
  ]

  for (const translation of translations) {
    await prisma.translation.upsert({
      where: { id: translation.id },
      update: {},
      create: translation,
    })
  }

  // --- Видання (§4.4) -------------------------------------------------------
  // «Місто» лишається без перекладу: це видання мовою оригіналу (textKind = ORIGINAL, lang = мова твору).
  const editions = [
    {
      id: 'seed-edition-shantaram-ksd',
      workId: 'seed-work-shantaram',
      translationId: 'seed-translation-shantaram-uk',
      textKind: EditionTextKind.TRANSLATION,
      lang: 'uk',
      publisher: 'Клуб сімейного дозвілля',
      year: 2019,
      isbn13: '9786171262737',
      pageCount: 800,
      format: EditionFormat.HARDCOVER,
      createdById: 'seed-user-marta',
    },
    {
      id: 'seed-edition-hobbit-veselka',
      workId: 'seed-work-hobbit',
      translationId: 'seed-translation-hobbit-mokrovolsky',
      textKind: EditionTextKind.TRANSLATION,
      lang: 'uk',
      publisher: 'Веселка',
      year: 1985,
      pageCount: 304,
      format: EditionFormat.HARDCOVER,
      createdById: 'seed-user-oles',
    },
    {
      id: 'seed-edition-hobbit-astrolabe',
      workId: 'seed-work-hobbit',
      translationId: 'seed-translation-hobbit-oniryshkevych',
      textKind: EditionTextKind.TRANSLATION,
      lang: 'uk',
      publisher: 'Астролябія',
      year: 2021,
      isbn13: '9786176642411',
      pageCount: 384,
      format: EditionFormat.PAPERBACK,
      createdById: 'seed-user-oles',
    },
    {
      id: 'seed-edition-misto-znannia',
      workId: 'seed-work-misto',
      translationId: null,
      textKind: EditionTextKind.ORIGINAL,
      lang: 'uk',
      publisher: 'Знання',
      year: 2016,
      isbn13: '9786170703606',
      pageCount: 328,
      format: EditionFormat.POCKET,
      createdById: 'seed-user-bohdan',
    },
  ]

  for (const edition of editions) {
    await prisma.edition.upsert({
      where: { id: edition.id },
      update: {},
      create: edition,
    })
  }

  // --- Примірники (§4.5) ----------------------------------------------------
  // Два примірники одного видання в Олеся — це два рядки Copy, а не поле quantity (§3).
  // Усі вдома: currentHolderId = ownerId (інваріант §5.3.2). Позичання — етап 2.
  const copies = [
    {
      id: 'seed-copy-shantaram-marta',
      editionId: 'seed-edition-shantaram-ksd',
      ownerId: 'seed-user-marta',
      condition: Condition.GOOD,
      note: 'Кавова пляма на сторінці 213',
    },
    {
      id: 'seed-copy-hobbit-veselka-oles',
      editionId: 'seed-edition-hobbit-veselka',
      ownerId: 'seed-user-oles',
      condition: Condition.WORN,
      note: null,
    },
    {
      id: 'seed-copy-hobbit-astrolabe-oles-1',
      editionId: 'seed-edition-hobbit-astrolabe',
      ownerId: 'seed-user-oles',
      condition: Condition.NEW,
      note: null,
    },
    {
      id: 'seed-copy-hobbit-astrolabe-oles-2',
      editionId: 'seed-edition-hobbit-astrolabe',
      ownerId: 'seed-user-oles',
      condition: Condition.GOOD,
      note: 'Другий примірник — на подарунок',
    },
    {
      id: 'seed-copy-misto-bohdan',
      editionId: 'seed-edition-misto-znannia',
      ownerId: 'seed-user-bohdan',
      condition: Condition.GOOD,
      note: null,
    },
  ]

  for (const copy of copies) {
    await prisma.copy.upsert({
      where: { id: copy.id },
      update: {},
      create: { ...copy, currentHolderId: copy.ownerId },
    })
  }
}

async function main(): Promise<void> {
  // `prisma db seed` успадковує оточення від CLI, який уже підвантажив кореневий
  // .env через prisma.config.ts. Цей рядок потрібен для прямого `tsx prisma/seed.ts`.
  loadDotenv({ path: resolve(__dirname, '../../../.env'), quiet: true })

  const connectionString = process.env.DATABASE_URL

  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL не задано — перевір .env у корені репозиторію')
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

  try {
    await seed(prisma)
    process.stdout.write('Seed виконано\n')
  } finally {
    await prisma.$disconnect()
  }
}

// `prisma db seed` виконує цей файл як скрипт; при імпорті з тестів main() мовчить.
if (require.main === module) {
  void main()
}
