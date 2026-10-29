import { keyUnder, type AvatarStorage } from './avatar-storage'

export interface StoredAvatar {
  bytes: Buffer
  contentType: string
}

/**
 * BS-148: photos in the API process, served by the API itself (`GET /avatars/:owner/:file`), so a
 * fresh clone shows uploaded photos without R2 keys. Everything is gone after a restart — the app
 * then shows initials instead. Forbidden in production by `env.validation.ts`.
 */
export class InMemoryAvatarStorage implements AvatarStorage {
  private readonly objects = new Map<string, StoredAvatar>()

  /**
   * `baseUrl` — this API's own root, e.g. `http://localhost:3001/api/v1`: keys start with `avatars/`,
   * so photos land on `GET /avatars/:owner/:file`.
   */
  constructor(private readonly baseUrl: string) {}

  put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType })

    return Promise.resolve()
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key)

    return Promise.resolve()
  }

  get(key: string): StoredAvatar | undefined {
    return this.objects.get(key)
  }

  urlFor(key: string): string {
    return `${this.baseUrl}/${key}`
  }

  keyFor(url: string): string | null {
    return keyUnder(this.baseUrl, url)
  }
}
