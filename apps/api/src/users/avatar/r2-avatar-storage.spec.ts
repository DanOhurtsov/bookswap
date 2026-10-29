import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { R2AvatarStorage } from './r2-avatar-storage'

const config = {
  accountId: 'acc123',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  bucket: 'bookswap-avatars',
  publicBaseUrl: 'https://avatars.example.com',
}

describe('R2AvatarStorage (BS-148)', () => {
  let send: jest.SpyInstance

  beforeEach(() => {
    // The SDK's overloaded `send` has no single output type to name; the tests read only the input.
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never)
  })

  afterEach(() => {
    send.mockRestore()
  })

  it('talks to the account’s R2 endpoint, region auto', async () => {
    const storage = new R2AvatarStorage(config)
    const client = (storage as unknown as { client: S3Client }).client
    const endpoint = await client.config.endpoint?.()

    expect(endpoint?.hostname).toBe('acc123.r2.cloudflarestorage.com')
    expect(await client.config.region()).toBe('auto')
  })

  it('puts the photo into the bucket under its key, cacheable forever', async () => {
    const bytes = Buffer.from('webp')

    await new R2AvatarStorage(config).put('avatars/u-1/a.webp', bytes, 'image/webp')

    const [command] = send.mock.calls[0] as [PutObjectCommand]

    expect(command).toBeInstanceOf(PutObjectCommand)
    expect(command.input).toEqual({
      Bucket: 'bookswap-avatars',
      Key: 'avatars/u-1/a.webp',
      Body: bytes,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  })

  it('deletes by key from the same bucket', async () => {
    await new R2AvatarStorage(config).delete('avatars/u-1/a.webp')

    const [command] = send.mock.calls[0] as [DeleteObjectCommand]

    expect(command).toBeInstanceOf(DeleteObjectCommand)
    expect(command.input).toEqual({ Bucket: 'bookswap-avatars', Key: 'avatars/u-1/a.webp' })
  })

  it('addresses photos on the public domain and recognizes only its own addresses', () => {
    const storage = new R2AvatarStorage(config)

    expect(storage.urlFor('avatars/u-1/a.webp')).toBe(
      'https://avatars.example.com/avatars/u-1/a.webp',
    )
    expect(storage.keyFor('https://avatars.example.com/avatars/u-1/a.webp')).toBe(
      'avatars/u-1/a.webp',
    )
    expect(storage.keyFor('https://cdn.example.com/avatars/u-1/a.webp')).toBeNull()
    expect(storage.keyFor('https://avatars.example.com.evil.test/avatars/u-1/a.webp')).toBeNull()
    expect(storage.keyFor('https://avatars.example.com/')).toBeNull()
  })
})
