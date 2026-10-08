import { ConfigService } from '@nestjs/config'
import {
  DevEmailSender,
  DevEmailSenderInProductionError,
  assertNotProduction,
} from './dev-email-sender'

/** Мінімальний ConfigService: віддає рівно те значення NODE_ENV, яке просять. */
function configWith(nodeEnv: string | undefined): ConfigService {
  return { get: () => nodeEnv } as unknown as ConfigService
}

const message = {
  to: 'marta@example.com',
  subject: 'BookSwap: підтвердіть адресу',
  body: 'http://localhost:3000/verify-email?token=SEKRET-TOKEN',
}

describe('assertNotProduction', () => {
  it.each(['development', 'test', undefined])('пропускає NODE_ENV=%s', (nodeEnv) => {
    expect(() => {
      assertNotProduction(nodeEnv)
    }).not.toThrow()
  })

  it('відхиляє саме production', () => {
    expect(() => {
      assertNotProduction('production')
    }).toThrow(DevEmailSenderInProductionError)
  })

  it('не плутає production із схожими значеннями', () => {
    // Точний збіг, без нормалізації: 'staging' і 'production-like' — не прод,
    // і робити їх недоступними мовчазним «включає підрядок» було б сюрпризом.
    for (const nodeEnv of ['Production', 'production ', 'preproduction', 'staging']) {
      expect(() => {
        assertNotProduction(nodeEnv)
      }).not.toThrow()
    }
  })
})

describe('DevEmailSender у production', () => {
  /**
   * Відмова на старті переїхала в `env.validation.ts`: `NODE_ENV=production`
   * вимагає `EMAIL_PROVIDER=resend` (§7.2). Конструктор мовчить навмисно — із
   * появою другого провайдера існування цього об'єкта в контейнері перестало
   * означати його використання, і падіння тут ламало б цілком коректний прод.
   */
  it('створюється, бо в контейнері може лежати незадіяним', () => {
    expect(() => new DevEmailSender(configWith('production'))).not.toThrow()
  })

  it('повідомлення помилки пояснює, що робити далі', async () => {
    const sender = new DevEmailSender(configWith('production'))

    await expect(sender.send(message)).rejects.toThrow(/EmailSender/)
    await expect(sender.send(message)).rejects.toThrow(/NODE_ENV=production/)
  })

  it('відмовляє в send(), навіть якщо екземпляр створено повз контейнер', async () => {
    let nodeEnv = 'development'
    const sender = new DevEmailSender({ get: () => nodeEnv } as unknown as ConfigService)

    nodeEnv = 'production'

    await expect(sender.send(message)).rejects.toThrow(DevEmailSenderInProductionError)
  })

  it('у production не лишає токен ні в лозі, ні в outbox', async () => {
    let nodeEnv = 'development'
    const sender = new DevEmailSender({ get: () => nodeEnv } as unknown as ConfigService)
    const logged: string[] = []

    jest.spyOn(sender['logger'], 'log').mockImplementation((value: unknown) => {
      logged.push(String(value))
    })

    nodeEnv = 'production'
    await expect(sender.send(message)).rejects.toThrow(DevEmailSenderInProductionError)

    expect(logged).toHaveLength(0)
    expect(sender.outbox).toHaveLength(0)
  })

  it('спирається на process.env, коли конфіг мовчить', async () => {
    const previous = process.env.NODE_ENV

    try {
      process.env.NODE_ENV = 'production'

      // Порожній ConfigService не має ставати способом обійти перевірку.
      const sender = new DevEmailSender(configWith(undefined))

      await expect(sender.send(message)).rejects.toThrow(DevEmailSenderInProductionError)
    } finally {
      process.env.NODE_ENV = previous
    }
  })
})

describe('DevEmailSender поза production', () => {
  let sender: DevEmailSender

  beforeEach(() => {
    sender = new DevEmailSender(configWith('test'))
  })

  it('друкує тіло листа цілком — це єдиний спосіб дістати посилання локально', async () => {
    const logged: string[] = []
    jest.spyOn(sender['logger'], 'log').mockImplementation((value: unknown) => {
      logged.push(String(value))
    })

    await sender.send(message)

    expect(logged.join('\n')).toContain(message.body)
    expect(logged.join('\n')).toContain(message.to)
  })

  it('складає листи в outbox і віддає останній для адреси', async () => {
    await sender.send(message)
    await sender.send({ ...message, subject: 'Другий' })

    expect(sender.outbox).toHaveLength(2)
    expect(sender.lastTo(message.to)?.subject).toBe('Другий')
    expect(sender.lastTo('nikoho@example.com')).toBeUndefined()
  })

  it('outbox обмежений — це не сховище', async () => {
    for (let i = 0; i < 60; i += 1) {
      await sender.send({ ...message, subject: `Лист ${String(i)}` })
    }

    expect(sender.outbox).toHaveLength(50)
    expect(sender.outbox[0]?.subject).toBe('Лист 10')
  })

  it('віддає копію outbox, а не внутрішній масив', async () => {
    await sender.send(message)

    const snapshot = sender.outbox as EmailMessageArray

    snapshot.length = 0

    expect(sender.outbox).toHaveLength(1)
  })

  it('clear() спорожнює outbox', async () => {
    await sender.send(message)
    sender.clear()

    expect(sender.outbox).toHaveLength(0)
  })

  describe('sealed (Stage 10, 10i.2, D2)', () => {
    const secret = {
      ...message,
      to: 'gost@guest.invalid',
      subject: 'BookSwap: код',
      body: 'Код підтвердження: 123456',
    }

    it('не друкує ні адресу, ні тіло (токен/код) у лог і не кладе лист у звичайний outbox', async () => {
      const logged: string[] = []

      jest.spyOn(sender['logger'], 'log').mockImplementation((value: unknown) => {
        logged.push(String(value))
      })

      await sender.send({ ...secret, sealed: true })

      const output = logged.join('\n')

      expect(output).not.toContain('gost@guest.invalid')
      expect(output).not.toContain('123456')
      expect(output).toContain('[приховано]')
      expect(sender.outbox).toHaveLength(0)
      expect(sender.lastTo(secret.to)).toBeUndefined()
    })

    it('sealed важливіший за redactRecipient: навіть разом із ним тіло в лог не потрапляє', async () => {
      const logged: string[] = []

      jest.spyOn(sender['logger'], 'log').mockImplementation((value: unknown) => {
        logged.push(String(value))
      })

      await sender.send({ ...secret, sealed: true, redactRecipient: true })

      expect(logged.join('\n')).not.toContain('123456')
      expect(sender.sealedTo(secret.to)?.body).toContain('123456')
    })

    it('віддає лист лише через sealedTo (без урахування регістру й пробілів), не лишаючи адресу відкритою', async () => {
      await sender.send({ ...secret, sealed: true })

      expect(sender.sealedTo('  GOST@guest.invalid ')).toEqual({
        subject: secret.subject,
        body: secret.body,
      })
      expect(sender.sealedTo('inshyj@guest.invalid')).toBeUndefined()
      expect(JSON.stringify(sender['sealed'])).not.toContain('gost@guest.invalid')
    })

    it('sealedTo віддає копію, останній лист для адреси перемагає, clear() спорожнює', async () => {
      await sender.send({ ...secret, sealed: true })
      await sender.send({ ...secret, body: 'Код підтвердження: 654321', sealed: true })

      const found = sender.sealedTo(secret.to)

      expect(found?.body).toContain('654321')

      if (found !== undefined) found.body = 'зіпсовано'

      expect(sender.sealedTo(secret.to)?.body).toContain('654321')

      sender.clear()

      expect(sender.sealedTo(secret.to)).toBeUndefined()
    })

    it('сховище обмежене', async () => {
      for (let i = 0; i < 60; i += 1) {
        await sender.send({ ...secret, to: `g${String(i)}@guest.invalid`, sealed: true })
      }

      expect(sender.sealedTo('g0@guest.invalid')).toBeUndefined()
      expect(sender.sealedTo('g59@guest.invalid')).toBeDefined()
    })

    it('у production відмовляє й нічого не лишає', async () => {
      let nodeEnv = 'development'
      const prod = new DevEmailSender({ get: () => nodeEnv } as unknown as ConfigService)

      nodeEnv = 'production'

      await expect(prod.send({ ...secret, sealed: true })).rejects.toThrow(
        DevEmailSenderInProductionError,
      )
      expect(prod.sealedTo(secret.to)).toBeUndefined()
    })
  })

  describe('redactRecipient (Stage 10, 10g, Q4)', () => {
    it('не потрапляє в outbox, не лишає адресу в лозі, але лишає тіло з посиланням', async () => {
      const logged: string[] = []

      jest.spyOn(sender['logger'], 'log').mockImplementation((value: unknown) => {
        logged.push(String(value))
      })

      await sender.send({ ...message, redactRecipient: true })

      expect(sender.outbox).toHaveLength(0)
      expect(sender.lastTo(message.to)).toBeUndefined()
      expect(logged.join('\n')).not.toContain(message.to)
      // Без API-поля з токеном лог лишається єдиним способом пройти флоу вручну (§0.8).
      expect(logged.join('\n')).toContain(message.body)
      expect(logged.join('\n')).toContain('[приховано]')
    })

    it('не впливає на звичайні листи до й після себе', async () => {
      await sender.send(message)
      await sender.send({ ...message, redactRecipient: true })
      await sender.send({ ...message, subject: 'Другий звичайний' })

      expect(sender.outbox).toHaveLength(2)
      expect(sender.outbox.map((item) => item.subject)).toEqual([
        message.subject,
        'Другий звичайний',
      ])
    })

    it('redactRecipient=false поводиться так само, як його відсутність', async () => {
      await sender.send({ ...message, redactRecipient: false })

      expect(sender.outbox).toHaveLength(1)
      expect(sender.lastTo(message.to)).toBeDefined()
    })
  })
})

/** Знімає readonly лише в межах тесту, який навмисно намагається зіпсувати копію. */
type EmailMessageArray = { length: number }
