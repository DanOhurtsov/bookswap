import { resolve } from 'node:path'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { validateEnv } from '../config/env.validation'
import { GuestContactRetentionCleanupService } from '../external-borrowers/guest-contact-retention-cleanup.service'
import { PrismaModule } from '../prisma/prisma.module'

/** §12.2: `.env` — один, у корені репозиторію. Той самий відносний шлях, що й `merge-cli.module.ts`. */
const ROOT_ENV_PATH = resolve(__dirname, '../../../../.env')

/**
 * Stage 10 (10h, Q1 §0.9 execution plan): мінімальний контекст під щоденну retention-чистку
 * гостьових контактів — лише Prisma й сам сервіс чистки. Той самий принцип, що й `MergeCliModule`
 * (`merge-cli.module.ts`): `AppModule` тут НЕ використовується, щоб не піднімати диспетчер
 * сповіщень, дайджест, Telegram-бота чи HTTP-шар заради адмінського/scheduler-запуску — і щоб не
 * давати їм шансу щось надіслати посеред цієї операції.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ROOT_ENV_PATH,
      validate: validateEnv,
    }),
    PrismaModule,
  ],
  providers: [GuestContactRetentionCleanupService],
})
export class GuestContactRetentionCliModule {}
