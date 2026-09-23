import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * jsdom не вантажить `globals.css`, тому компонентний тест сканера не може
 * перевірити самі обмеження — а дефект був саме в них: `<video>` без CSS
 * розкладався в intrinsic-розмір потоку (на iPhone 1280×720 і більше) і давав
 * горизонтальний overflow. Тут фіксуємо контракт декларацій; те, що розмітка
 * справді використовує ці класи, перевіряє `BarcodeScannerPanel.spec.tsx`.
 */
const css = readFileSync(join(__dirname, 'globals.css'), 'utf8')

function ruleBody(selector: string): string {
  const body = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1]

  if (body === undefined) throw new Error(`CSS rule ${selector} not found in globals.css`)

  return body
}

describe('.scanner__viewport', () => {
  const body = ruleBody('.scanner__viewport')

  it('fills the available width instead of the stream width', () => {
    expect(body).toMatch(/\bwidth:\s*100%/)
    expect(body).toMatch(/\bmax-width:\s*min\(100%,/)
  })

  it('caps its height against the viewport so status and cancel stay reachable', () => {
    expect(body).toMatch(/\bmax-height:\s*\d+(?:\.\d+)?s?vh\b/)
  })

  it('clips the scaled frame rather than letting it push the page sideways', () => {
    expect(body).toMatch(/\boverflow:\s*hidden\b/)
  })
})

describe('.scanner__video', () => {
  const body = ruleBody('.scanner__video')

  it('scales the frame to the box with object-fit, leaving the MediaStream intact', () => {
    expect(body).toMatch(/\bobject-fit:\s*cover\b/)
    expect(body).toMatch(/\bwidth:\s*100%/)
    expect(body).toMatch(/\bheight:\s*100%/)
  })
})

describe('.scanner__overlay', () => {
  const body = ruleBody('.scanner__overlay')

  it('covers the preview as a centered column, so the hint sits right above the frame', () => {
    expect(body).toMatch(/\bposition:\s*absolute\b/)
    expect(body).toMatch(/\binset:\s*0\b/)
    expect(body).toMatch(/\bflex-direction:\s*column\b/)
    expect(body).toMatch(/\bjustify-content:\s*center\b/)
  })

  it('is purely visual: neither hint nor frame intercepts taps meant for the preview', () => {
    expect(body).toMatch(/\bpointer-events:\s*none\b/)
  })
})

describe('.scanner__hint', () => {
  const body = ruleBody('.scanner__hint')

  it('carries its own contrast so it reads over a light frame, not just a dark one', () => {
    expect(body).toMatch(/\bcolor:\s*#fff\b/)
    expect(body).toMatch(/\bbackground:\s*rgb\(0 0 0\s*\/\s*0?\.\d+\)/)
  })
})

describe('.scanner__frame', () => {
  const body = ruleBody('.scanner__frame')

  it('stays visible over both light and dark video via a light border on a dark shadow', () => {
    expect(body).toMatch(/\bborder:\s*2px solid rgb\(255 255 255/)
    expect(body).toMatch(/\bbox-shadow:[\s\S]*rgb\(0 0 0/)
  })

  it('keeps the barcode aspect ratio instead of being squashed by flex', () => {
    expect(body).toMatch(/\baspect-ratio:\s*5\s*\/\s*2\b/)
    expect(body).toMatch(/\bflex:\s*none\b/)
  })
})
