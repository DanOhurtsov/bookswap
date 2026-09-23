import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import type { NextConfig } from 'next'

/**
 * §12.2 наказує тримати єдиний `.env` у корені, а Next бачить лише `.env` усередині
 * власної теки. Тому читаємо кореневий файл вручну.
 *
 * Свідомо `dotenv.parse`, а НЕ `dotenv.config`: другий залив би в `process.env`
 * геть усе, включно з `DATABASE_URL`. Далі пропускаємо лише префікс `NEXT_PUBLIC_` —
 * єдине, що Next має право інлайнити в клієнтський бандл. Наслідок: серверні
 * секрети не потрапляють навіть у процес складання, не кажучи про бандл.
 */
function loadPublicEnvFromRoot(): void {
  const envPath = resolve(process.cwd(), '../../.env')
  if (!existsSync(envPath)) return

  for (const [key, value] of Object.entries(parse(readFileSync(envPath)))) {
    if (!key.startsWith('NEXT_PUBLIC_')) continue
    // Справжнє оточення (CI, docker) має пріоритет над файлом.
    process.env[key] ??= value
  }
}

loadPublicEnvFromRoot()

const allowedDevOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0)

const nextConfig: NextConfig = {
  ...(allowedDevOrigins?.length ? { allowedDevOrigins } : {}),
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'covers.openlibrary.org' },
      { protocol: 'https', hostname: 'books.google.com' },
      { protocol: 'https', hostname: 'books.googleusercontent.com' },
      { protocol: 'https', hostname: 'images.isbndb.com' },
    ],
  },
  // Явний білий список того, що доїде до браузера.
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001',
  },
}

export default nextConfig
