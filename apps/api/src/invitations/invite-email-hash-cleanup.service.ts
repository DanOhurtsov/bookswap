import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { BACKGROUND_MODE, type BackgroundMode } from '../common/background'
import { PrismaService } from '../prisma/prisma.service'
import { EMAIL_RECIPIENT_LIMIT_WINDOW_MS } from './invitation.rules'

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000

/**
 * Stage 10 (10g, Q5): `Invitation.recipientEmailHash` — довготривалий похідний
 * ідентифікатор гостя (R4), і Етап 9 його ніколи не чистив. Цей прохід обнуляє поле
 * рівно тоді, коли воно перестає бути потрібним: `EMAIL_RECIPIENT_LIMIT_WINDOW_MS` —
 * те саме 7-денне вікно, яким `InvitationsService` рахує ліміт на одну адресу. Поки
 * запис у вікні, ліміт може його побачити — хеш лишається; щойно запис випав з
 * вікна — жодна перевірка вже на нього не дивиться, і хеш можна обнулити.
 *
 * Поле спільне для звичайних email-запрошень Етапу 9 і гостьових (10g) — обидва
 * `kind = 'EMAIL'`, і прохід охоплює всі такі рядки, не лише гостьові. Сам
 * `Invitation`, `tokenHash`, 14-денний строк дії (`expiresAt`) і факти
 * `InvitationAcceptance` цей прохід не чіпає: чинний інвайт лишається прийнятним і
 * після того, як його `recipientEmailHash` обнулили.
 */
@Injectable()
export class InviteEmailHashCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InviteEmailHashCleanupService.name)
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly prisma: PrismaService,
    /** Замовчування діє лише для ручного `new`; Nest бере значення з провайдера. */
    @Inject(BACKGROUND_MODE) private readonly background: BackgroundMode = 'enabled',
  ) {}

  onModuleInit(): void {
    // Той самий інваріант, що й `SessionCleanupService`: в e2e фон вимкнений разом з
    // рештою фонової роботи. `run()` лишається публічним для детермінованого тесту.
    if (this.background === 'disabled') return

    this.timer = setInterval(() => {
      void this.run()
    }, CLEANUP_INTERVAL_MS)

    // Без unref() таймер тримає процес живим — і jest після e2e не завершується.
    this.timer.unref()
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
  }

  /**
   * Помилка тут не має валити застосунок: наступний тик спробує знову. Публічний,
   * щоб тест міг прогнати чистку детерміновано, підставивши `now`, не чекаючи
   * інтервалу.
   */
  async run(now = new Date()): Promise<void> {
    try {
      const threshold = new Date(now.getTime() - EMAIL_RECIPIENT_LIMIT_WINDOW_MS)
      const { count } = await this.prisma.invitation.updateMany({
        where: { kind: 'EMAIL', recipientEmailHash: { not: null }, createdAt: { lte: threshold } },
        data: { recipientEmailHash: null },
      })

      if (count > 0) {
        this.logger.log(`Очищено recipientEmailHash прострочених запрошень: ${String(count)}`)
      }
    } catch (error) {
      this.logger.error('Не вдалося очистити recipientEmailHash', error)
    }
  }
}
