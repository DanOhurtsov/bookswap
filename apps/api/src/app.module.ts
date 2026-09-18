import { resolve } from 'node:path'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { AccessModule } from './access/access.module'
import { AnalyticsModule } from './analytics/analytics.module'
import { AuthModule } from './auth/auth.module'
import { CatalogModule } from './catalog/catalog.module'
import { validateEnv } from './config/env.validation'
import { EmailModule } from './email/email.module'
import { FriendsModule } from './friends/friends.module'
import { HealthModule } from './health/health.module'
import { HistoryModule } from './history/history.module'
import { LibraryImportModule } from './library/import/library-import.module'
import { LibraryModule } from './library/library.module'
import { LoansModule } from './loans/loans.module'
import { NotificationsModule } from './notifications/notifications.module'
import { PrismaModule } from './prisma/prisma.module'
import { TelegramApiModule } from './telegram/telegram-api.module'
import { TelegramModule } from './telegram/telegram.module'
import { UsersModule } from './users/users.module'
import { WishlistModule } from './wishlist/wishlist.module'

/**
 * §12.2: `.env` — один, у корені репозиторію. Шлях однаковий і для `src/`, і для
 * зібраного `dist/` (обидва лежать на одному рівні всередині apps/api).
 */
const ROOT_ENV_PATH = resolve(__dirname, '../../../.env')

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ROOT_ENV_PATH,
      validate: validateEnv,
    }),
    /**
     * §11: rate limiting. Сховище — в пам'яті процесу, і це навмисно: §2 прямо
     * виключає Redis зі стека v1, а на десятках користувачів і одному процесі
     * лічильник у пам'яті робить рівно те, що треба.
     *
     * Guard тут НЕ глобальний: §11 вимагає ліміти на чутливих ендпоінтах, а не
     * на всьому API. Кожен такий маршрут вішає `@UseGuards(ThrottlerGuard)` і
     * власний `@Throttle` — видно прямо в контролері, що саме обмежено й наскільки.
     * Значення нижче — стеля, яку ті `@Throttle` звужують.
     */
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'auth', limit: 120, ttl: 60_000 },
        // docs/plan/stage-7.md, 7b: окремий бакет для GET /catalog/lookup —
        // інша природа захисту, ніж 'auth' (див. common/rate-limit.config.ts).
        { name: 'lookup', limit: 120, ttl: 60_000 },
        // Stage 8f-2, §4: CSV import. Один preview може означати сотні ISBN,
        // тож він не ділить бакет ні з 'auth', ні з 'lookup'.
        { name: 'import', limit: 240, ttl: 60_000 },
      ],
    }),
    PrismaModule,
    AnalyticsModule,
    EmailModule,
    // Транспорт Telegram — глобальний і без доменних залежностей, як і пошта.
    // Сам бот (`TelegramModule`) підключається нижче, після `LoansModule`.
    TelegramApiModule,
    AccessModule,
    NotificationsModule,
    AuthModule,
    UsersModule,
    FriendsModule,
    CatalogModule,
    LibraryModule,
    LibraryImportModule,
    WishlistModule,
    LoansModule,
    TelegramModule,
    HistoryModule,
    HealthModule,
  ],
})
export class AppModule {}
