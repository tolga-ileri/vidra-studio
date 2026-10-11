import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

afterEach(() => cleanup())

// jsdom gaps used by Radix primitives.
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= RO as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= function () {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => Math.random().toString(16).slice(2) + "-uuid" })
}
