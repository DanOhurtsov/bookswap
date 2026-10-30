/**
 * Embla needs `ResizeObserver`, `IntersectionObserver` and `matchMedia`, which jsdom lacks. These do
 * nothing and match nothing: jsdom lays nothing out, so there is nothing to observe. Call it at the top
 * of a spec that renders the carousel; the real ones are exercised in the browser spec.
 */
export function installCarouselEnvironment(): void {
  class Inert {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }

  const matchMedia = (media: string): MediaQueryList =>
    ({
      matches: false,
      media,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList

  beforeAll(() => {
    Object.assign(window, { ResizeObserver: Inert, IntersectionObserver: Inert, matchMedia })
  })
}
