import { Controller, Get, Injectable, UseGuards, type INestApplication } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import type { App } from 'supertest/types'
import { configureApp } from '../app.setup'
import { GuestLoansEnabledGuard } from './guest-loans-enabled.guard'

const downstream = {
  session: jest.fn(() => true),
  service: jest.fn(() => ({ ok: true })),
}

/** Stands in for `SessionGuard`: the real one hits the database. */
@Injectable()
class SessionProbeGuard {
  canActivate(): boolean {
    return downstream.session()
  }
}

@Controller('probe')
@UseGuards(GuestLoansEnabledGuard, SessionProbeGuard)
class ProbeController {
  @Get()
  handle(): { ok: boolean } {
    return downstream.service()
  }
}

async function appWith(flag: unknown): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      GuestLoansEnabledGuard,
      SessionProbeGuard,
      { provide: ConfigService, useValue: { get: () => flag } },
    ],
  }).compile()
  const app = moduleRef.createNestApplication<INestApplication<App>>()

  configureApp(app)
  await app.init()

  return app
}

describe('GuestLoansEnabledGuard', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([[false], [undefined], ['true'], [1]])(
    '403 FEATURE_DISABLED before session and handler when the flag is %p',
    async (flag) => {
      const app = await appWith(flag)

      const response = await request(app.getHttpServer()).get('/api/v1/probe')

      expect(response.status).toBe(403)
      expect(response.body).toMatchObject({ code: 'FEATURE_DISABLED' })
      expect(downstream.session).not.toHaveBeenCalled()
      expect(downstream.service).not.toHaveBeenCalled()

      await app.close()
    },
  )

  it('lets the request through when the flag is explicitly true', async () => {
    const app = await appWith(true)

    const response = await request(app.getHttpServer()).get('/api/v1/probe')

    expect(response.status).toBe(200)
    expect(downstream.session).toHaveBeenCalledTimes(1)
    expect(downstream.service).toHaveBeenCalledTimes(1)

    await app.close()
  })
})
