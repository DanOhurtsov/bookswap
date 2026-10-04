import type { PrismaClient } from '../../src/generated/prisma/client'

/**
 * Мінімальний зв'язний граф каталогу: Work → Translation → Edition → Copy плюс
 * власник і потенційний позичальник. Ланцюг не спрощується — саме на ньому
 * тримаються перевірки нижче.
 */
export interface Graph {
  ownerId: string
  borrowerId: string
  workId: string
  translationId: string
  editionId: string
  copyId: string
}

let counter = 0

function unique(prefix: string): string {
  counter += 1

  return `${prefix}-${String(counter)}`
}

export async function createUser(prisma: PrismaClient, displayName = 'Тест'): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: `${unique('user')}@example.com`,
      passwordHash: 'test-placeholder',
      displayName,
    },
  })

  return user.id
}

/**
 * Обидва id опційні: e2e-тестам граф потрібен на вже зареєстрованих користувачів,
 * бо лоан має належати тим самим людям, які дружать через API. Для db-тестів, яким
 * байдуже, хто власник, поведінка лишається незмінною.
 */
export interface GraphOptions {
  ownerId?: string
  borrowerId?: string
}

export async function createGraph(
  prisma: PrismaClient,
  options: GraphOptions = {},
): Promise<Graph> {
  const ownerId = options.ownerId ?? (await createUser(prisma, 'Власник'))
  const borrowerId = options.borrowerId ?? (await createUser(prisma, 'Позичальник'))

  const work = await prisma.work.create({
    data: {
      title: 'Шантарам',
      titleNorm: 'шантарам',
      origLang: 'en',
      createdById: ownerId,
    },
  })

  const translation = await prisma.translation.create({
    data: {
      workId: work.id,
      translator: 'Перекладач',
      lang: 'uk',
      sourceLang: 'en',
      createdById: ownerId,
    },
  })

  const edition = await prisma.edition.create({
    data: {
      workId: work.id,
      translationId: translation.id,
      textKind: 'TRANSLATION',
      lang: 'uk',
      createdById: ownerId,
    },
  })

  const copy = await prisma.copy.create({
    data: { editionId: edition.id, ownerId, currentHolderId: ownerId },
  })

  return {
    ownerId,
    borrowerId,
    workId: work.id,
    translationId: translation.id,
    editionId: edition.id,
    copyId: copy.id,
  }
}

/**
 * Дружба `ACCEPTED` між двома людьми.
 *
 * Пара нормалізується тут же: §4.3 вимагає `userAId < userBId`, і CHECK
 * `friendship_ab_ordered` цього не пробачає. Тримати ту саму сортову умову в
 * кожному тесті означало б переписувати її на кожен новий файл.
 */
export async function createFriendship(
  prisma: PrismaClient,
  oneId: string,
  otherId: string,
): Promise<string> {
  const [userAId, userBId] = [oneId, otherId].sort()

  if (userAId === undefined || userBId === undefined) throw new Error('Недосяжно: пара з двох id')

  const friendship = await prisma.friendship.create({
    data: { userAId, userBId, status: 'ACCEPTED', requestedById: oneId, respondedAt: new Date() },
  })

  return friendship.id
}

/**
 * Помилки БД у тестах перевіряються за текстом, а не лише за фактом падіння:
 * інакше тест лишається зеленим, коли запит падає з зовсім іншої причини.
 */
export async function expectRejection(
  promise: Promise<unknown>,
  matcher: RegExp,
): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    expect(String(error)).toMatch(matcher)

    return error
  }

  throw new Error(`Очікувалася помилка БД за ${String(matcher)}, але запит пройшов`)
}

/**
 * Порушення унікальності. Крім тексту звіряється код P2002 — інакше тест лишиться
 * зеленим на будь-якій іншій помилці, що згадала ту саму колонку.
 */
export async function expectUniqueViolation(
  promise: Promise<unknown>,
  field: RegExp,
): Promise<void> {
  const error = await expectRejection(promise, /Unique constraint failed/)

  expect(String(error)).toMatch(field)
  expect((error as { code?: unknown }).code).toBe('P2002')
}
