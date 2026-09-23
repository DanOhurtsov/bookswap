import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'dotenv'
import type { NextConfig } from 'next'

/**
 * §12.2 наказує тримати єдиний `.env` у корені, а Next бачить лише `.env` усередині
 * власної теки. Тому читаємо кореневий файл вручну.
 *
 * Свідомо `dotenv.parse`, а НЕ `dotenv.config`: другий залив би в `process.env`
 * геть усе, включно з `DATABASE_URL`. Читаємо лише `NEXT_PUBLIC_*` та явне
 * налаштування dev-сервера `NEXT_ALLOWED_DEV_ORIGINS`. Останнє не додається
 * до `nextConfig.env`, тому не експортується у клієнтський бандл.
 */
function loadWebEnvFromRoot(): void {
  const envPath = resolve(process.cwd(), '../../.env')
  if (!existsSync(envPath)) return

  for (const [key, value] of Object.entries(parse(readFileSync(envPath)))) {
    if (!key.startsWith('NEXT_PUBLIC_') && key !== 'NEXT_ALLOWED_DEV_ORIGINS') continue
    // Справжнє оточення (CI, docker) має пріоритет над файлом.
    process.env[key] ??= value
  }
}

loadWebEnvFromRoot()

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
