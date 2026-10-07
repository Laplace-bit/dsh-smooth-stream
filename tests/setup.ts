import { afterEach, beforeEach, vi } from 'vitest'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  })
})
afterEach(() => {
  FrameCoordinator.forDocument(document).shutdown()
})
