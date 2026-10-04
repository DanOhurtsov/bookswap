'use client'

import { isValidIsbn13, normalizeIsbn13 } from '@bookswap/shared'
import { ScanBarcodeIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  isScannerSupported,
  startBarcodeScanner,
  type BarcodeScanError,
  type BarcodeScanErrorReason,
  type ScannerHandle,
  type StartScannerOptions,
} from '../lib/barcode-scanner.client'

export type BarcodeScannerPanelProps = {
  onValidIsbn: (isbn: string) => void
  /** Test-only injection, forwarded verbatim to `startBarcodeScanner`. */
  loadScannerModules?: StartScannerOptions['loadScannerModules']
}

type ScanPhase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'invalid-code' }
  | { kind: 'error'; reason: BarcodeScanErrorReason }

const ERROR_MESSAGES: Record<BarcodeScanErrorReason, string> = {
  'permission-denied':
    'Доступ до камери заборонено. Дозвольте камеру в налаштуваннях браузера або введіть ISBN вручну.',
  'no-camera': 'Камеру не знайдено на цьому пристрої. Введіть ISBN вручну.',
  'camera-busy':
    'Камера зайнята іншим застосунком або недоступна. Спробуйте ще раз або введіть ISBN вручну.',
  unsupported: 'Сканування недоступне в цьому браузері або зʼєднанні. Введіть ISBN вручну.',
  timeout: 'Не вдалося розпізнати штрих-код. Спробуйте ще раз або введіть ISBN вручну.',
  unknown: 'Не вдалося увімкнути камеру. Спробуйте ще раз або введіть ISBN вручну.',
}

/**
 * Камера вмикається лише кнопкою `handleStart` (R2) — ніколи в ефекті чи на
 * монтуванні. `<video>` рендериться завжди (щоб `videoRef` був доступний до
 * кліку), але прихована поза активним скануванням.
 */
export function BarcodeScannerPanel({ onValidIsbn, loadScannerModules }: BarcodeScannerPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const handleRef = useRef<ScannerHandle | undefined>(undefined)
  const [phase, setPhase] = useState<ScanPhase>({ kind: 'idle' })

  useEffect(() => {
    return () => {
      handleRef.current?.stop()
    }
  }, [])

  function handleDecoded(rawText: string): void {
    if (!isValidIsbn13(rawText)) {
      setPhase({ kind: 'invalid-code' })
      return
    }

    handleRef.current?.stop()
    setPhase({ kind: 'idle' })
    onValidIsbn(normalizeIsbn13(rawText))
  }

  function handleError(error: BarcodeScanError): void {
    setPhase({ kind: 'error', reason: error.reason })
  }

  function handleStart(): void {
    if (!isScannerSupported()) {
      setPhase({ kind: 'error', reason: 'unsupported' })
      return
    }

    const video = videoRef.current
    if (video === null) return

    handleRef.current = startBarcodeScanner({
      video,
      onDecoded: handleDecoded,
      onError: handleError,
      loadScannerModules,
    })
    setPhase({ kind: 'scanning' })
  }

  function handleCancel(): void {
    handleRef.current?.stop()
    setPhase({ kind: 'idle' })
  }

  const isActive = phase.kind === 'scanning' || phase.kind === 'invalid-code'

  const startLabel = phase.kind === 'error' ? 'Спробувати знову' : 'Сканувати штрихкод'

  return (
    <div className="contents">
      {/* Корінь — `display: contents`: кнопка стає клітинкою ряду пошуку поруч з інпутом, а помилка
          розтягується під ним на всю ширину. Камера відкривається попапом поверх сторінки. */}
      <Button
        type="button"
        size="icon"
        className="size-11 cursor-pointer"
        aria-label={startLabel}
        title={startLabel}
        onClick={handleStart}
      >
        <ScanBarcodeIcon aria-hidden="true" className="size-4" />
      </Button>

      <Dialog
        open={isActive}
        onOpenChange={(open) => {
          if (!open) handleCancel()
        }}
      >
        {/* `keepMounted`: `<video>` мусить існувати ще до кліку (R2) — `handleStart` бере `videoRef` синхронно
            в обробнику кліку, а не з ефекту. Поки попап закритий, він лише прихований. */}
        <DialogContent keepMounted showCloseButton={false} className="sm:max-w-md">
          <DialogTitle>Сканування штрихкоду</DialogTitle>
          <div
            data-slot="scanner-viewport"
            className="relative aspect-[4/3] max-h-[38svh] w-full max-w-[min(100%,24rem)] justify-self-stretch overflow-hidden rounded-md border border-[color:var(--line)] bg-black"
          >
            <video
              ref={videoRef}
              data-slot="scanner-video"
              className="block size-full object-cover"
              aria-label="Перегляд камери для сканування штрих-коду"
              playsInline
              muted
            />
            {/* Підпис і рамка — одна центрована колонка, тому підпис тримається
                прямо над рамкою сам, без магічних відступів. Оверлей не перехоплює
                взаємодію; рамка — суто орієнтир для наведення, і текст ніде не
                обіцяє, що її зона щось обмежує: ZXing декодує весь кадр. */}
            <div
              data-slot="scanner-overlay"
              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-3"
            >
              {isActive && (
                <p
                  data-slot="scanner-hint"
                  role="status"
                  className="max-w-full flex-none rounded-[0.4rem] bg-black/70 px-[0.7rem] py-[0.35rem] text-center text-[0.9rem] leading-[1.35] font-semibold text-balance text-white"
                >
                  {phase.kind === 'invalid-code'
                    ? 'Це не схоже на ISBN-13. Спробуйте ще раз.'
                    : 'Наведіть штрих-код у рамку'}
                </p>
              )}
              <div
                data-slot="scanner-frame"
                aria-hidden="true"
                className="aspect-[5/2] w-[84%] flex-none rounded-[0.35rem] border-2 border-white/95 shadow-[0_0_0_2px_rgb(0_0_0/0.55),inset_0_0_0_2px_rgb(0_0_0/0.55)]"
              />
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-11 cursor-pointer"
            onClick={handleCancel}
          >
            Скасувати
          </Button>
        </DialogContent>
      </Dialog>

      {phase.kind === 'error' && (
        <p className="alert alert--error col-span-full" role="alert">
          {ERROR_MESSAGES[phase.reason]}
        </p>
      )}
    </div>
  )
}
