import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type FunctionComponent } from 'react'
import { useSmoothStreamContent, type UseSmoothStreamContentOptions } from '../src/client/useSmoothStreamContent.ts'

/**
 * Regression suite for the `commitIntervalMs` commit throttle.
 *
 * The reveal loop keeps running every frame, but each React commit pays for a
 * full Markdown AST + Shiki + DOM reconciliation. `commitIntervalMs` batches
 * revealed characters into fewer, larger commits while the throttle window is
 * open, and the producer-complete tail must still drain without waiting for
 * the interval.
 *
 * Frames are driven one at a time through a rAF stub and a virtual clock, so
 * every assertion is deterministic and no Harness packages are involved.
 */

const FRAME_MS = 16

let clock = 0
let pendingFrame: FrameRequestCallback | null = null
let commits: Array<{ now: number; shown: string }> = []

function advanceFrame(): void {
  const callback = pendingFrame
  if (callback === null) return
  pendingFrame = null
  clock += FRAME_MS
  act(() => { callback(clock) })
}

function advanceFrames(count: number): void {
  for (let index = 0; index < count; index += 1) advanceFrame()
}

/** Renders the real hook and records every committed display value. */
function Probe({ content, options }: { content: string; options: UseSmoothStreamContentOptions }) {
  const displayed = useSmoothStreamContent(content, options)
  if (commits.at(-1)?.shown !== displayed) commits.push({ now: clock, shown: displayed })
  return createElement('pre', { 'data-testid': 'stream' }, displayed)
}

type ProbeProps = { content: string; options: UseSmoothStreamContentOptions }

function mount(content: string, options: UseSmoothStreamContentOptions = {}): void {
  render(createElement(Probe as FunctionComponent<ProbeProps>, { content, options }))
}

function remount(content: string, options: UseSmoothStreamContentOptions = {}): void {
  cleanup()
  clock = 0
  pendingFrame = null
  commits = []
  mount(content, options)
}

/** Smallest gap between two consecutive commits, in ms. */
function minCommitGap(): number {
  let smallest = Number.POSITIVE_INFINITY
  for (let index = 1; index < commits.length; index += 1) {
    smallest = Math.min(smallest, commits[index]!.now - commits[index - 1]!.now)
  }
  return smallest
}

function shown(): string {
  return document.querySelector('[data-testid="stream"]')?.textContent ?? ''
}

const STREAM_TEXT = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'

describe('useSmoothStreamContent commit batching', () => {
  beforeEach(() => {
    clock = 0
    pendingFrame = null
    commits = []
    vi.stubGlobal('performance', { now: () => clock })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      pendingFrame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => { pendingFrame = null })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('commits once per frame when no throttle is configured', () => {
    mount(STREAM_TEXT)
    advanceFrames(8)
    expect(commits.length).toBeGreaterThan(4)
    expect(minCommitGap()).toBe(FRAME_MS)
  })

  it('never commits inside the throttle window and still reveals in order', () => {
    mount(STREAM_TEXT, { commitIntervalMs: 32 })
    advanceFrames(8)
    expect(commits.length).toBeGreaterThan(1)
    // Three 16ms frames are the first a throttled commit may follow the opening one.
    expect(minCommitGap()).toBeGreaterThanOrEqual(32)
    expect(STREAM_TEXT.startsWith(shown())).toBe(true)
  })

  it('coalesces frames into strictly fewer commits than the unthrottled cadence', () => {
    mount(STREAM_TEXT)
    advanceFrames(8)
    const unthrottled = commits.length
    remount(STREAM_TEXT, { commitIntervalMs: 32 })
    advanceFrames(8)
    expect(commits.length).toBeLessThan(unthrottled)
  })

  it('cuts the commit count without stretching the completion drain', () => {
    mount(STREAM_TEXT, { inputComplete: true })
    let unthrottledFrames = 0
    while (shown().length < STREAM_TEXT.length && unthrottledFrames < 400) {
      advanceFrame()
      unthrottledFrames += 1
    }
    const unthrottledCommits = commits.length
    expect(shown()).toBe(STREAM_TEXT)

    remount(STREAM_TEXT, { commitIntervalMs: 32, inputComplete: true })
    let throttledFrames = 0
    while (shown().length < STREAM_TEXT.length && throttledFrames < 400) {
      advanceFrame()
      throttledFrames += 1
    }
    // Batching must not drop characters, stall the tail, or lengthen the
    // completion drain — it only spends fewer React commits getting there.
    expect(shown()).toBe(STREAM_TEXT)
    expect(throttledFrames).toBe(unthrottledFrames)
    expect(commits.length).toBeLessThan(unthrottledCommits)
  })
})
