import 'reflect-metadata'
import { parseArgs } from 'node:util'
import { NestFactory } from '@nestjs/core'
import { MergeService } from '../catalog/merge/merge.service'
import { WorkMergeError } from '../catalog/merge/merge-errors'
import { MergeCliModule } from './merge-cli.module'

/**
 * §6.3: «об'єднати два `Work`» — у v1 адмінський скрипт, не ендпоінт.
 *
 * Запуск (з кореня репозиторію):
 *
 *   pnpm --filter @bookswap/api run merge:works --from <workId> --into <workId>
 *
 * Файл свідомо тонкий: розбір аргументів, один виклик `MergeService`, код
 * виходу. Уся логіка й усі тести живуть на сервісі — інакше перевіряти мерж
 * можна було б лише запуском процесу.
 *
 * Коди виходу: 0 — злито, 1 — операцію не виконано, 2 — неправильний виклик.
 */

const USAGE = 'Виклик: merge-works --from <workId> --into <workId>'

/**
 * Вивід — прямо в потоки, а не через Nest `Logger`.
 *
 * Дві причини. По-перше, контекст піднімається з `logger: false`, щоб не
 * засипати оператора рядками про ініціалізацію модулів, — а це глушить і власні
 * виклики `Logger`. По-друге, звіт про адмінську операцію не є логом
 * застосунку: мітки часу й теги `[Nest]` тут лише заважають читати й грепати.
 */
function out(line: string): void {
  process.stdout.write(`${line}\n`)
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`)
}

interface Arguments {
  from: string
  into: string
}

function readArguments(): Arguments | undefined {
  let values: { from?: string; into?: string }

  try {
    ;({ values } = parseArgs({
      options: {
        from: { type: 'string' },
        into: { type: 'string' },
      },
    }))
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    fail(USAGE)

    return undefined
  }

  const { from, into } = values

  if (from === undefined || into === undefined || from === '' || into === '') {
    fail('Обидва аргументи обовʼязкові: --from і --into')
    fail(USAGE)

    return undefined
  }

  return { from, into }
}

async function main(): Promise<void> {
  const parsed = readArguments()

  if (parsed === undefined) {
    process.exitCode = 2

    return
  }

  const app = await NestFactory.createApplicationContext(MergeCliModule, { logger: false })

  try {
    const summary = await app.get(MergeService).merge(parsed.from, parsed.into)

    out(`Твір ${summary.sourceWorkId} злито у ${summary.targetWorkId}`)
    out(`  перекладів перенесено:      ${String(summary.translationsMoved)}`)
    out(`  видань перенесено:          ${String(summary.editionsMoved)}`)
    out(`  рецензій перенесено:        ${String(summary.reviewsMoved)}`)
    out(`  рецензій заархівовано (R5): ${String(summary.reviewsArchived)}`)
    out(`  вішлиста перенесено:        ${String(summary.wishlistItemsMoved)}`)
    out(`  дублів вішлиста прибрано:   ${String(summary.wishlistDuplicatesRemoved)}`)
    out(`  статусів читання перенесено:${String(summary.readingStatusesMoved)}`)
    out(`  дублів статусів читання:    ${String(summary.readingStatusDuplicatesRemoved)}`)
    out(`  звʼязків авторів перенесено:${String(summary.authorLinksMoved)}`)
    out(`  дублів звʼязків авторів:    ${String(summary.authorLinksDuplicatesRemoved)}`)
    out(`  вхідних мержів перенято:    ${String(summary.incomingMergesRepointed)}`)
  } catch (error) {
    process.exitCode = 1

    if (error instanceof WorkMergeError) {
      fail(`${error.code}: ${error.message}`)
    } else {
      fail('Несподівана помилка, злиття не відбулося')
      fail(error instanceof Error ? (error.stack ?? error.message) : String(error))
    }
  } finally {
    await app.close()
  }
}

void main()
