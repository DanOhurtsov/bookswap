import { HttpStatus } from '@nestjs/common'
import { API_ERROR_CODES, AVATAR_RULES } from '@bookswap/shared'
import sharp from 'sharp'
import { ApiException } from '../../common/api.exception'

type AvatarSourceType = (typeof AVATAR_RULES.types)[number]

/**
 * A decompression bomb is a small file that decodes into a huge bitmap. 5 MB of JPEG never honestly
 * needs more than this (a 50-megapixel photo); sharp's own default is five times larger.
 */
const MAX_INPUT_PIXELS = 50_000_000

/** WebP quality for a 512 px portrait: visually clean, ~30–60 KB. */
const WEBP_QUALITY = 82

/**
 * The type the bytes themselves declare, by their signature. `Content-Type` is the sender's claim and
 * is never consulted: a renamed file or a forged header changes nothing here.
 */
export function sniffAvatarType(bytes: Buffer): AvatarSourceType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }

  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}

/**
 * BS-148: an uploaded photo turned into what is stored — a centred square, `AVATAR_RULES.side` px,
 * WebP, upright (EXIF orientation applied) and without any metadata: sharp writes none unless asked,
 * so the camera, the GPS position and the original file never leave this function.
 *
 * Refuses with the API's own errors: not a JPEG/PNG/WebP (or not decodable as one) — 415; shorter
 * side under `AVATAR_RULES.minSide` — 422. The size limit is the body parser's (`app.setup.ts`).
 */
export async function toStoredAvatar(bytes: Buffer): Promise<Buffer> {
  if (sniffAvatarType(bytes) === null) throw unsupportedType()

  const source = (): sharp.Sharp => sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })

  let width: number | undefined
  let height: number | undefined

  try {
    ;({ width, height } = await source().metadata())
  } catch {
    // A valid signature on a broken or oversized body: to the person it is still "not a photo".
    throw unsupportedType()
  }

  if (width === undefined || height === undefined) throw unsupportedType()

  if (Math.min(width, height) < AVATAR_RULES.minSide) throw tooSmall()

  try {
    return await source()
      .rotate()
      .resize(AVATAR_RULES.side, AVATAR_RULES.side, { fit: 'cover', position: 'centre' })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()
  } catch {
    throw unsupportedType()
  }
}

function unsupportedType(): ApiException {
  return new ApiException(
    API_ERROR_CODES.AVATAR_UNSUPPORTED_TYPE,
    'Підтримуються JPG, PNG і WebP',
    HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  )
}

function tooSmall(): ApiException {
  return new ApiException(
    API_ERROR_CODES.AVATAR_TOO_SMALL,
    `Фото замале: потрібно щонайменше ${String(AVATAR_RULES.minSide)}×${String(AVATAR_RULES.minSide)} пікселів`,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
}
