import { CanActivate, HttpStatus, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { API_ERROR_CODES } from '@bookswap/shared'
import { ApiException } from './api.exception'

/**
 * Stage 10 §7.3 (T9): rejects every guest-loan route with 403 `FEATURE_DISABLED`
 * while `GUEST_LOANS_ENABLED` is off. Reads config only — no service, no database.
 *
 * Must be listed before `SessionGuard` in `@UseGuards`, so a disabled feature
 * never even touches the session table. It does not lift D2.
 */
@Injectable()
export class GuestLoansEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<boolean>('GUEST_LOANS_ENABLED') !== true) {
      throw new ApiException(
        API_ERROR_CODES.FEATURE_DISABLED,
        'Функція вимкнена',
        HttpStatus.FORBIDDEN,
      )
    }

    return true
  }
}
