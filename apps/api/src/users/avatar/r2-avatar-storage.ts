import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { keyUnder, type AvatarStorage } from './avatar-storage'

export interface R2AvatarConfig {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** The bucket's public address, without a trailing slash (`R2_PUBLIC_BASE_URL`). */
  publicBaseUrl: string
}

/**
 * BS-148: Cloudflare R2 through its S3-compatible API. Browsers load photos from the bucket's public
 * domain, never through the API. Setup, token scope and key rotation: docs/runbooks/r2-avatars.md.
 */
export class R2AvatarStorage implements AvatarStorage {
  private readonly client: S3Client

  constructor(private readonly config: R2AvatarConfig) {
    this.client = new S3Client({
      // R2 has no regions; `auto` is what it documents for the S3 SDK.
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    })
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        // Every upload gets a new random key, so an address never changes what it shows.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    )
  }

  async delete(key: string): Promise<void> {
    // S3 semantics: deleting a missing key succeeds, which is exactly the contract.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }

  urlFor(key: string): string {
    return `${this.config.publicBaseUrl}/${key}`
  }

  keyFor(url: string): string | null {
    return keyUnder(this.config.publicBaseUrl, url)
  }
}
