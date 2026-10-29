import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { Me } from '@bookswap/shared'
import { PrismaService } from '../../prisma/prisma.service'
import { toMe } from '../user.mapper'
import { toStoredAvatar } from './avatar-image'
import { AVATAR_STORAGE, type AvatarStorage } from './avatar-storage'
import type { UserModel } from '../../generated/prisma/models'

/**
 * BS-148: the profile photo — the only way `User.avatarUrl` changes since `PATCH /me` lost the field.
 *
 * Order matters: the new photo is stored first, then the profile points at it, and only then is the
 * old one deleted. A failure at any step leaves the profile showing a photo that exists. Deleting is
 * best-effort: an orphaned object costs a few kilobytes, a failed request over it would cost the
 * person their new photo.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name)

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AVATAR_STORAGE) private readonly storage: AvatarStorage,
  ) {}

  async upload(user: UserModel, bytes: Buffer): Promise<Me> {
    const photo = await toStoredAvatar(bytes)
    // A new random key per upload: the public address of a photo never changes what it shows, so
    // browsers and the CDN may cache it forever, and nobody can guess the next one.
    const key = `avatars/${user.id}/${randomUUID()}.webp`

    await this.storage.put(key, photo, 'image/webp')

    let updated: UserModel

    try {
      updated = await this.prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: this.storage.urlFor(key) },
      })
    } catch (error) {
      await this.forget(key)
      throw error
    }

    await this.forgetUrl(user.avatarUrl)

    return toMe(updated)
  }

  async remove(user: UserModel): Promise<Me> {
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarUrl: null },
    })

    await this.forgetUrl(user.avatarUrl)

    return toMe(updated)
  }

  /** Only this storage's own photos: an address from before BS-148 is someone else's file. */
  private async forgetUrl(url: string | null): Promise<void> {
    const key = url === null ? null : this.storage.keyFor(url)

    if (key !== null) await this.forget(key)
  }

  private async forget(key: string): Promise<void> {
    try {
      await this.storage.delete(key)
    } catch (error) {
      // The key is enough to find the orphan in the bucket later.
      this.logger.warn(`Не вдалося видалити фото ${key}: ${String(error)}`)
    }
  }
}
