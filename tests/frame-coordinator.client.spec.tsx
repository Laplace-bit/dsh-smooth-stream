/**
 * FrameCoordinator contract: one document owns exactly ONE live animation
 * frame while any task is registered, phases run in read -> simulate -> write
 * order inside that single frame, and the clock parks itself when idle.
 *
 * These assertions are the "单时钟" gate from the 60 FPS refactor plan: the
 * old architecture armed an independent rAF chain per concern (reveal, follow,
 * fade, fps monitor, tool-text reveal) while a reply streamed.
 *
 * The driver is a hand-pumped rAF stub so frame timing is fully deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameCoordinator } from '../src/client/FrameCoordinator.ts'

interface FrameClock {
  /** Frames requested since the last reset. */
  rafCalls: number
  cancelled: number
  pending: Map<number, FrameRequestCallback>
  frame: (now: number) => void
}

function installFrameClock(): FrameClock {
  let nextHandle = 1
  const clock: FrameClock = {
    rafCalls: 0,
    cancelled: 0,
    pending: new Map<number, FrameRequestCallback>(),
    frame(now: number): void {
      const due = [...clock.pending.entries()]
      clock.pending.clear()
      for (const [, callback] of due) callback(now)
    },
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    clock.rafCalls += 1
    const handle = nextHandle++
    clock.pending.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    clock.cancelled += 1
    clock.pending.delete(handle)
  })
  return clock
}

/** The coordinator is a per-document singleton: start every test pristine. */
function pristine(clock: FrameClock): FrameCoordinator {
  const coordinator = FrameCoordinator.forDocument(document)
  coordinator.shutdown()
  clock.rafCalls = 0
  clock.pending.clear()
  return coordinator
}

describe('FrameCoordinator', () => {
  let clock: FrameClock
  let coordinator: FrameCoordinator

  beforeEach(() => {
    clock = installFrameClock()
    coordinator = pristine(clock)
  })

  afterEach(() => {
    coordinator.shutdown()
    vi.unstubAllGlobals()
  })

  it('arms exactly one frame no matter how many tasks register', () => {
    coordinator.registerTask({ onSimulate: () => true })
    expect(clock.rafCalls).toBe(1)
    coordinator.registerTask({ onSimulate: () => true })
    coordinator.registerTask({ onSimulate: () => true })
    coordinator.registerTask({ onSimulate: () => true })
    // Four concerns, one document: still a single live frame.
    expect(clock.rafCalls).toBe(1)
    expect(coordinator.taskCount).toBe(4)
  })

  it('runs read before simulate before write inside a single frame', () => {
    const order: string[] = []
    coordinator.registerTask({
      onRead: () => order.push('read'),
      onSimulate: () => { order.push('simulate'); return true },
      onWrite: () => order.push('write'),
    })

    // Frame 1 only establishes the time base; frame 2 runs the phases.
    clock.frame(1000)
    clock.frame(1016)
    expect(order).toEqual(['simulate', 'write'])

    order.length = 0
    coordinator.markLayoutDirty()
    clock.frame(1032)
    expect(order).toEqual(['read', 'simulate', 'write'])
  })

  it('gives every task the same frame timestamp', () => {
    const seen: number[] = []
    coordinator.registerTask({ onSimulate: (_dt, now) => { seen.push(now); return true } })
    coordinator.registerTask({ onSimulate: (_dt, now) => { seen.push(now); return true } })

    clock.frame(1000)
    clock.frame(1016)
    expect(seen).toEqual([1016, 1016])
  })

  it('parks the clock once no task is active, and wakes on request', () => {
    let active = true
    coordinator.registerTask({ onSimulate: () => active, onWrite: () => {} })

    clock.frame(1000)
    clock.frame(1016)
    expect(coordinator.active).toBe(true)

    active = false
    clock.frame(1032)
    // The frame was not re-armed: the loop parked itself.
    expect(coordinator.active).toBe(false)

    const before = clock.rafCalls
    coordinator.markLayoutDirty()
    expect(clock.rafCalls).toBe(before + 1)
  })

  it('reuses one coordinator per document', () => {
    expect(FrameCoordinator.forDocument(document)).toBe(coordinator)
  })

  it('keeps the clock stopped while it has no tasks', () => {
    expect(coordinator.active).toBe(false)
    expect(coordinator.taskCount).toBe(0)
    // A read with no owner still drains, then parks again.
    coordinator.markLayoutDirty()
    clock.frame(1000)
    clock.frame(1016)
    expect(coordinator.active).toBe(false)
  })

  it('ignores a stale unregister handle', () => {
    coordinator.registerTask({ onSimulate: () => true })
    coordinator.unregisterTask(null)
    coordinator.unregisterTask(undefined)
    expect(coordinator.taskCount).toBe(1)
  })

  it('stops the clock when its last task unregisters', () => {
    const id = coordinator.registerTask({ onSimulate: () => true })
    expect(clock.rafCalls).toBe(1)
    coordinator.unregisterTask(id)
    expect(clock.cancelled).toBe(1)
    expect(coordinator.active).toBe(false)
  })
})
