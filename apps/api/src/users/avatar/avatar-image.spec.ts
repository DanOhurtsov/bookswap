import { API_ERROR_CODES, AVATAR_RULES } from '@bookswap/shared'
import sharp from 'sharp'
import { ApiException } from '../../common/api.exception'
import { sniffAvatarType, toStoredAvatar } from './avatar-image'

function image(width: number, height: number): sharp.Sharp {
  return sharp({ create: { width, height, channels: 3, background: '#2e7d5b' } })
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ApiException) return (error.getResponse() as { code: string }).code
    throw error
  }

  return undefined
}

describe('sniffAvatarType (BS-148)', () => {
  it('reads JPEG, PNG and WebP by their signatures', async () => {
    expect(sniffAvatarType(await image(10, 10).jpeg().toBuffer())).toBe('image/jpeg')
    expect(sniffAvatarType(await image(10, 10).png().toBuffer())).toBe('image/png')
    expect(sniffAvatarType(await image(10, 10).webp().toBuffer())).toBe('image/webp')
  })

  it('refuses anything else, whatever it would be called', async () => {
    expect(sniffAvatarType(await image(10, 10).gif().toBuffer())).toBeNull()
    expect(sniffAvatarType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(sniffAvatarType(Buffer.from('RIFF0000WAVE'))).toBeNull()
    expect(sniffAvatarType(Buffer.alloc(0))).toBeNull()
  })
})

describe('toStoredAvatar (BS-148)', () => {
  it('stores a centred square of the configured side, as WebP', async () => {
    const stored = await toStoredAvatar(await image(900, 400).png().toBuffer())
    const { format, width, height } = await sharp(stored).metadata()

    expect({ format, width, height }).toEqual({
      format: 'webp',
      width: AVATAR_RULES.side,
      height: AVATAR_RULES.side,
    })
  })

  it('crops the centre: the edges of a wide photo are cut off, not squeezed in', async () => {
    // Red left third, green middle, blue right third. A centred square keeps only the green;
    // squeezing the whole photo in would leave a third of each edge colour.
    const third = 300
    const solid = (background: string) =>
      sharp({ create: { width: third, height: third, channels: 3, background } })
        .png()
        .toBuffer()
    const wide = await sharp({
      create: { width: third * 3, height: third, channels: 3, background: '#ff0000' },
    })
      .composite([
        { input: await solid('#00ff00'), left: third, top: 0 },
        { input: await solid('#0000ff'), left: third * 2, top: 0 },
      ])
      .png()
      .toBuffer()

    const [red, green, blue] = (await sharp(await toStoredAvatar(wide)).stats()).channels

    expect(red?.mean).toBeLessThan(10)
    expect(blue?.mean).toBeLessThan(10)
    expect(green?.mean).toBeGreaterThan(240)
  })

  it('keeps no metadata: EXIF from the camera never reaches storage', async () => {
    const withExif = await image(600, 600)
      .jpeg()
      .withExif({ IFD0: { Copyright: 'Марта', Artist: 'GPS-and-all' } })
      .toBuffer()

    expect((await sharp(withExif).metadata()).exif).toBeDefined()

    const stored = await sharp(await toStoredAvatar(withExif)).metadata()

    expect(stored.exif).toBeUndefined()
    expect(stored.orientation).toBeUndefined()
  })

  it('accepts exactly the minimum shorter side, refuses one pixel less', async () => {
    const min = AVATAR_RULES.minSide

    await expect(toStoredAvatar(await image(min, 2000).png().toBuffer())).resolves.toBeInstanceOf(
      Buffer,
    )
    expect(
      await codeOf(
        toStoredAvatar(
          await image(min - 1, 2000)
            .png()
            .toBuffer(),
        ),
      ),
    ).toBe(API_ERROR_CODES.AVATAR_TOO_SMALL)
  })

  it('refuses a non-image and a GIF as an unsupported type', async () => {
    expect(await codeOf(toStoredAvatar(Buffer.from('not a photo')))).toBe(
      API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE,
    )
    expect(await codeOf(toStoredAvatar(await image(600, 600).gif().toBuffer()))).toBe(
      API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE,
    )
  })

  it('refuses a valid signature over broken bytes as an unsupported type, not a crash', async () => {
    const png = await image(600, 600).png().toBuffer()

    expect(await codeOf(toStoredAvatar(png.subarray(0, 40)))).toBe(
      API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE,
    )
  })
})
