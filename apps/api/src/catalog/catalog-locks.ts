import type { PrismaService } from '../prisma/prisma.service'

/**
 * Єдиний порядок блокувань для всього, що чіпає мову й тип тексту видань
 * (docs/plan/fast-book-add.md, ред. 2.1, «Конкурентність каскадів мови»):
 *
 *     Work  →  Translation  →  Edition   (всередині кожного рівня — за `id`)
 *
 * Той самий порядок, що в `MergeService.lockWorks` і в записувачі імпорту: тому PATCH твору, PATCH
 * перекладу, PATCH видання, створення видання, злиття й швидке додавання серіалізуються на ОДНОМУ
 * рядку `Work` і не можуть ні розминутися (мова видання узгоджена з твором, що вже змінився), ні
 * взяти блокування у зворотному порядку й заклинити одне одного.
 */
export type LockClient = Pick<PrismaService, '$queryRaw' | 'edition' | 'translation'>

export async function lockWork(tx: LockClient, workId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Work" WHERE "id" = ${workId} FOR UPDATE`
}

/**
 * Сутність (видання чи переклад) переїхала до іншого твору між читанням `workId` і блокуванням (злиття).
 *
 * Це НЕ привід блокувати новий твір у тій самій транзакції: вона вже тримає блокування старого `Work` і
 * самої сутності, а хтось інший може тримати новий `Work` і чекати саме на цю сутність — взаємне
 * очікування. Тому транзакція завершується цією помилкою (усі блокування звільняються), а повторює
 * операцію вже НОВА транзакція — `retryWhenWorkMoved`.
 */
export class WorkMovedError extends Error {
  constructor(entity: 'Translation' | 'Edition', id: string) {
    super(`${entity} ${id} перейшов до іншого твору під час блокування`)
    this.name = 'WorkMovedError'
  }
}

/** Скільки разів перезапускати ВСЮ транзакцію, коли сутність щойно переїхала (злиття — подія рідкісна). */
const MAX_ATTEMPTS = 3

/** Перезапускає транзакцію цілком (не всередині неї) при `WorkMovedError`; решту помилок не чіпає. */
export async function retryWhenWorkMoved<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!(error instanceof WorkMovedError) || attempt >= MAX_ATTEMPTS) throw error
    }
  }
}

/**
 * Блокує `Work`, потім `Translation`, і повертає `workId`, під яким переклад лежить. `null` — перекладу немає.
 * Переклад переїхав до іншого твору → `WorkMovedError` (транзакція завершується, не блокуючи нового твору).
 * Викликати лише всередині транзакції, яку обгорнуто в `retryWhenWorkMoved`.
 */
export async function lockTranslationInWork(
  tx: LockClient,
  translationId: string,
): Promise<string | null> {
  const found = await tx.translation.findUnique({
    where: { id: translationId },
    select: { workId: true },
  })

  if (found === null) return null

  await lockWork(tx, found.workId)
  await tx.$queryRaw`SELECT "id" FROM "Translation" WHERE "id" = ${translationId} FOR UPDATE`

  const again = await tx.translation.findUnique({
    where: { id: translationId },
    select: { workId: true },
  })

  if (again === null) return null
  if (again.workId !== found.workId) throw new WorkMovedError('Translation', translationId)

  return found.workId
}

/** Те саме для `Edition`: `Work`, потім сам рядок видання. */
export async function lockEditionInWork(tx: LockClient, editionId: string): Promise<string | null> {
  const found = await tx.edition.findUnique({ where: { id: editionId }, select: { workId: true } })

  if (found === null) return null

  await lockWork(tx, found.workId)
  await tx.$queryRaw`SELECT "id" FROM "Edition" WHERE "id" = ${editionId} FOR UPDATE`

  const again = await tx.edition.findUnique({ where: { id: editionId }, select: { workId: true } })

  if (again === null) return null
  if (again.workId !== found.workId) throw new WorkMovedError('Edition', editionId)

  return found.workId
}
