'use client'

import { isValidIsbn13, normalizeIsbn13 } from '@bookswap/shared'
import { useEffect, useRef, useState } from 'react'
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

  return (
    <div className="scanner">
      {/* Обгортка існує лише поки камера активна: інакше вона забирала б висоту
          порожнім чорним прямокутником. `<video>` при цьому НЕ розмонтовується —
          `videoRef` мусить бути доступний до першого кліку (R2). */}
      <div className="scanner__viewport" hidden={!isActive}>
        <video
          ref={videoRef}
          className="scanner__video"
          aria-label="Перегляд камери для сканування штрих-коду"
          playsInline
          muted
        />
        {/* Підпис і рамка — одна центрована колонка, тому підпис тримається
            прямо над рамкою сам, без магічних відступів. Оверлей не перехоплює
            взаємодію; рамка — суто орієнтир для наведення, і текст ніде не
            обіцяє, що її зона щось обмежує: ZXing декодує весь кадр. */}
        <div className="scanner__overlay">
          {isActive && (
            <p className="scanner__hint" role="status">
              {phase.kind === 'invalid-code'
                ? 'Це не схоже на ISBN-13. Спробуйте ще раз.'
                : 'Наведіть штрих-код у рамку'}
            </p>
          )}
          <div className="scanner__frame" aria-hidden="true" />
        </div>
      </div>

      {isActive && (
        <button type="button" onClick={handleCancel}>
          Скасувати
        </button>
      )}

      {(phase.kind === 'idle' || phase.kind === 'error') && (
        <button type="button" onClick={handleStart}>
          {phase.kind === 'error' ? 'Спробувати знову' : 'Сканувати штрихкод'}
        </button>
      )}

      {phase.kind === 'error' && (
        <p className="alert alert--error" role="alert">
          {ERROR_MESSAGES[phase.reason]}
        </p>
      )}
    </div>
  )
}
