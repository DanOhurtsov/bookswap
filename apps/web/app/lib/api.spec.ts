import { z } from 'zod'
import { apiRequest, apiRequestWithRedirect } from './api'

/**
 * §6.3 віддає 301 на змержений `Work`, і `fetch` іде за ним сам. Єдиний слід,
 * що перехід стався, — прапорець `redirected` на відповіді; без нього сторінка
 * показала б канонічні дані під старою адресою (DoD 7h).
 */
describe('apiRequestWithRedirect', () => {
  const schema = z.object({ id: z.string() })

  function stubFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): jest.Mock {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      redirected: false,
      json: () => Promise.resolve({ id: 'work-new' }),
      ...response,
    })

    global.fetch = mock as unknown as typeof fetch

    return mock
  }

  it('позначає відповідь, що приїхала через редирект', async () => {
    stubFetch({ redirected: true })

    await expect(apiRequestWithRedirect('/works/work-old', { schema })).resolves.toEqual({
      data: { id: 'work-new' },
      redirected: true,
    })
  })

  it('звичайна відповідь редиректом не позначається', async () => {
    stubFetch({ redirected: false })

    await expect(apiRequestWithRedirect('/works/work-new', { schema })).resolves.toEqual({
      data: { id: 'work-new' },
      redirected: false,
    })
  })

  it('204 не має тіла, але ознака переміщення лишається читабельною', async () => {
    stubFetch({ status: 204, redirected: true })

    await expect(apiRequestWithRedirect('/me/wishlist/work-old')).resolves.toEqual({
      data: undefined,
      redirected: true,
    })
  })

  it('apiRequest віддає саме тіло — решті викликів прапорець не потрібен', async () => {
    stubFetch({ redirected: true })

    await expect(apiRequest('/works/work-old', { schema })).resolves.toEqual({ id: 'work-new' })
  })
})

describe('apiRequest: тіло запиту', () => {
  function stubFetch(): jest.Mock {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      status: 204,
      redirected: false,
      json: () => Promise.resolve(undefined),
    })

    global.fetch = mock as unknown as typeof fetch

    return mock
  }

  function sentInit(mock: jest.Mock): RequestInit {
    const [, init] = mock.mock.calls[0] as [string, RequestInit]

    return init
  }

  it('обʼєкт іде як JSON із заголовком типу', async () => {
    const mock = stubFetch()

    await apiRequest('/me', { method: 'PATCH', body: { city: 'Вроцлав' } })

    expect(sentInit(mock)).toMatchObject({
      headers: { 'Content-Type': 'application/json' },
      body: '{"city":"Вроцлав"}',
    })
  })

  it('файл іде своїми байтами: без JSON і без чужого заголовка типу', async () => {
    const mock = stubFetch()
    const photo = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' })

    await apiRequest('/me/avatar', { method: 'POST', body: photo })

    expect(sentInit(mock).body).toBe(photo)
    expect(sentInit(mock).headers).toBeUndefined()
  })
})
