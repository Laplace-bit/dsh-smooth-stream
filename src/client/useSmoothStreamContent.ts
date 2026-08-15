/**
 * Stream-smoothing reveal hook.
 *
 * Buffers the model's chunked text and reveals it at a cadence that tracks
 * the observed arrival rate, so a long reply never dumps whole paragraphs at
 * once and a fast stream never stutters. Port of lobe-ui's smoother: EMA
 * arrival cps + chunk size, backlog pressure, commit-interval widening with
 * tail length, and a flush-speed settle drain once the input idles. The
 * reveal decision is the pure {@link computeRevealStep} for unit tests.
 *
 * `shouldHoldBack` is the performance guard's veto: while it returns true the
 * loop keeps measuring but skips the DOM commit, so an offscreen reply never
 * competes with visible frames when the frame rate is degraded.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export type StreamSmoothingPreset = 'realtime' | 'balanced' | 'silky'

export interface StreamSmoothingPresetConfig {
  readonly activeInputWindowMs: number
  readonly defaultCps: number
  readonly emaAlpha: number
  readonly flushCps: number
  readonly largeAppendChars: number
  readonly maxActiveCps: number
  readonly maxCps: number
  readonly maxFlushCps: number
  readonly minCommitIntervalMs: number
  readonly minCps: number
  readonly settleAfterMs: number
  readonly settleDrainMaxMs: number
  readonly settleDrainMinMs: number
  readonly targetBufferMs: number
}

export const PRESET_CONFIG: Record<StreamSmoothingPreset, StreamSmoothingPresetConfig> = {
  balanced: {
    activeInputWindowMs: 220,
    defaultCps: 80,
    emaAlpha: 0.35,
    flushCps: 180,
    largeAppendChars: 120,
    maxActiveCps: 360,
    maxCps: 240,
    maxFlushCps: 480,
    minCommitIntervalMs: 16,
    minCps: 24,
    settleAfterMs: 280,
    settleDrainMaxMs: 420,
    settleDrainMinMs: 120,
    targetBufferMs: 40,
  },
  realtime: {
    activeInputWindowMs: 140,
    defaultCps: 120,
    emaAlpha: 0.45,
    flushCps: 240,
    largeAppendChars: 180,
    maxActiveCps: 480,
    maxCps: 320,
    maxFlushCps: 640,
    minCommitIntervalMs: 16,
    minCps: 32,
    settleAfterMs: 200,
    settleDrainMaxMs: 280,
    settleDrainMinMs: 100,
    targetBufferMs: 24,
  },
  silky: {
    activeInputWindowMs: 280,
    defaultCps: 64,
    emaAlpha: 0.28,
    flushCps: 140,
    largeAppendChars: 100,
    maxActiveCps: 280,
    maxCps: 180,
    maxFlushCps: 400,
    minCommitIntervalMs: 16,
    minCps: 20,
    settleAfterMs: 360,
    settleDrainMaxMs: 520,
    settleDrainMinMs: 160,
    targetBufferMs: 56,
  },
}

const MAX_COMMIT_INTERVAL_MS = 16
/** Demo queue divisor: each frame reveals about `backlog / 8` characters. */
export const QUEUE_REVEAL_DIVISOR = 8
const QUEUE_FRAME_MS = 16.67
/** Hard cap on how far display may trail a live stream, in characters. */
export const LIVE_LAG_CHAR_CEILING = 32
const CATCHUP_SECONDS = 0.15

export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

/**
 * Demo per-frame reveal: drain `backlog / 8` characters, at least 1, scaled
 * by frame time. A small queue types one glyph per frame; a burst raises the
 * step so the display does not fall behind.
 * @param backlog - Unrevealed characters.
 * @param dtMs - Frame delta in ms.
 * @returns Characters to reveal this frame.
 */
export function computeQueueReveal(backlog: number, dtMs: number): number {
  if (backlog <= 0 || dtMs <= 0) return 0
  return Math.min(backlog, Math.max(1, Math.ceil((backlog / QUEUE_REVEAL_DIVISOR) * (dtMs / QUEUE_FRAME_MS))))
}

/** Counts user-perceived characters (code points), not UTF-16 units. */
export const countChars = (text: string): number => {
  let count = 0
  for (const char of text) {
    void char
    count += 1
  }
  return count
}

/**
 * Drain rate for backlog beyond the tail-lag ceiling: the displayed text may
 * trail the stream by at most `backlogCharCeiling` characters for at most
 * `backlogSecondCeiling` seconds. The constants are a smoothness invariant
 * (bounded lag is the reason the reveal never stalls mid-reply), so they are
 * not config fields; the preset multiplier is how a deployment tunes them.
 */
export const BACKLOG_CHAR_CEILING = 300
export const BACKLOG_SECOND_CEILING = 2

export interface SettleDrainInput {
  readonly backlog: number
  readonly inputActive: boolean
  readonly settling: boolean
}

/** Pure settle-drain decision shared by the frame loop and its tests. */
export function computeSettleDrain(config: StreamSmoothingPresetConfig, input: SettleDrainInput): number {
  if (input.inputActive || !input.settling) return 0
  // A settled stream must drain fast enough to finish the reply promptly:
  // lag beyond the ceiling drains within the second ceiling.
  const overflow = Math.max(0, input.backlog - BACKLOG_CHAR_CEILING)
  const overflowCps = (overflow * 1000) / BACKLOG_SECOND_CEILING
  const drainTargetMs = clamp(input.backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs)
  const settleCps = (input.backlog * 1000) / drainTargetMs
  return clamp(Math.max(settleCps, overflowCps), config.flushCps, config.maxFlushCps)
}

/**
 * Drain rate multiplier once the input ends: leftover backlog reveals at
 * this multiple of the steady rate, so the end never drags.
 */
export const SETTLE_DRAIN_MULTIPLIER = 1.8

export interface RevealStepInput {
  readonly backlog: number
  readonly chunkSizeEma: number
  readonly arrivalCpsEma: number
  readonly emaCps: number
  readonly inputActive: boolean
  readonly settling: boolean
  /** Fixed reveal rate; overrides the arrival-tracking cadence entirely. */
  readonly steadyCps?: number | undefined
}

export interface RevealStepResult {
  readonly revealChars: number
  readonly targetLagChars: number
}

/** Pure per-frame reveal decision shared by the loop and its tests. */
export function computeRevealStep(config: StreamSmoothingPresetConfig, input: RevealStepInput, dtSeconds: number): RevealStepResult {
  // Track the faster of the two EMAs and do not clamp to the old low maxCps
  // ceiling — that cap is why a fast model left hundreds of chars unrevealed.
  const trackedCps = Math.max(input.emaCps, input.arrivalCpsEma)
  const baseCps = clamp(trackedCps, config.minCps, config.maxFlushCps)
  const targetLagChars = input.inputActive
    ? Math.max(2, Math.round((baseCps * config.targetBufferMs) / 1000))
    : 0

  let currentCps: number
  if (input.steadyCps !== undefined) {
    currentCps = input.inputActive || input.settling
      ? clamp(
        input.steadyCps * (input.inputActive ? 1 : SETTLE_DRAIN_MULTIPLIER),
        config.minCps,
        config.maxFlushCps,
      )
      : 0
  } else if (input.inputActive) {
    const overflow = Math.max(0, input.backlog - LIVE_LAG_CHAR_CEILING)
    const catchup = overflow > 0 ? overflow / CATCHUP_SECONDS : 0
    currentCps = clamp(baseCps * 1.08 + catchup, config.minCps, config.maxFlushCps)
  } else if (input.settling) {
    currentCps = computeSettleDrain(config, input)
  } else {
    const idleFlushCps = Math.max(config.flushCps, baseCps * 1.8, input.arrivalCpsEma * 0.8)
    currentCps = clamp(idleFlushCps, config.flushCps, config.maxFlushCps)
  }

  const minRevealChars = input.inputActive ? 1 : 2
  return { revealChars: Math.max(minRevealChars, Math.round(currentCps * dtSeconds)), targetLagChars }
}

export interface UseSmoothStreamContentOptions {
  enabled?: boolean
  preset?: StreamSmoothingPreset
  /** Performance guard veto: while true, reveal commits are held back. */
  shouldHoldBack?: (() => boolean) | undefined
  /**
   * Fixed reveal rate in chars/s. When set, the reveal runs at this steady
   * pace while the input streams (instead of tracking the arrival rate) and
   * drains the leftover backlog at {@link SETTLE_DRAIN_MULTIPLIER} once the
   * input ends.
   */
  steadyCps?: number | undefined
  /**
   * Seed for the arrival-rate EMA. When omitted, the preset's `defaultCps`
   * is used. The live rate then tracks observed arrival; this is not a cap.
   */
  defaultCps?: number | undefined
  /** Written each commit with the live arrival-rate EMA for the follow lerp. */
  speedCpsRef?: { current: number } | undefined
}

/**
 * Smooth a chunked content stream into a reveal-paced display string.
 *
 * @param content - The full accumulated input so far.
 * @param options - Preset, guard, and steady-rate wiring.
 * @returns The displayed content, revealed at the smoothed cadence.
 */
export function useSmoothStreamContent(
  content: string,
  { enabled = true, preset = 'balanced', shouldHoldBack, steadyCps, defaultCps, speedCpsRef }: UseSmoothStreamContentOptions = {},
): string {
  const config = PRESET_CONFIG[preset]
  const seedCps = defaultCps ?? config.defaultCps
  const [displayedContent, setDisplayedContent] = useState(content)

  const displayedContentRef = useRef(content)
  const displayedCountRef = useRef(countChars(content))
  const targetContentRef = useRef(content)
  const targetCharsRef = useRef([...content])
  const targetCountRef = useRef(countChars(content))

  const emaCpsRef = useRef(seedCps)
  const lastInputTsRef = useRef(0)
  const lastInputCountRef = useRef(countChars(content))
  const chunkSizeEmaRef = useRef(1)
  const arrivalCpsEmaRef = useRef(seedCps)

  const rafRef = useRef<number | null>(null)
  const lastFrameTsRef = useRef<number | null>(null)
  const wakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdBackRef = useRef(shouldHoldBack)
  const speedOutRef = useRef(speedCpsRef)
  speedOutRef.current = speedCpsRef

  useEffect(() => {
    holdBackRef.current = shouldHoldBack
  }, [shouldHoldBack])

  const clearWakeTimer = useCallback(() => {
    if (wakeTimerRef.current !== null) {
      clearTimeout(wakeTimerRef.current)
      wakeTimerRef.current = null
    }
  }, [])

  const stopFrameLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastFrameTsRef.current = null
  }, [])

  const stopScheduling = useCallback(() => {
    stopFrameLoop()
    clearWakeTimer()
  }, [clearWakeTimer, stopFrameLoop])

  const startFrameLoopRef = useRef<() => void>(() => {})

  const scheduleFrameWake = useCallback(
    (delayMs: number) => {
      clearWakeTimer()
      wakeTimerRef.current = setTimeout(
        () => {
          wakeTimerRef.current = null
          startFrameLoopRef.current()
        },
        Math.max(1, Math.ceil(delayMs)),
      )
    },
    [clearWakeTimer],
  )

  const syncImmediate = useCallback(
    (nextContent: string) => {
      stopScheduling()
      const chars = [...nextContent]
      const now = performance.now()
      targetContentRef.current = nextContent
      targetCharsRef.current = chars
      targetCountRef.current = chars.length
      displayedContentRef.current = nextContent
      displayedCountRef.current = chars.length
      setDisplayedContent(nextContent)
      emaCpsRef.current = seedCps
      chunkSizeEmaRef.current = 1
      arrivalCpsEmaRef.current = seedCps
      lastInputTsRef.current = now
      lastInputCountRef.current = chars.length
    },
    [seedCps, stopScheduling],
  )

  const startFrameLoop = useCallback(() => {
    clearWakeTimer()
    if (rafRef.current !== null) return

    const tick = () => {
      const targetCount = targetCountRef.current
      const displayedCount = displayedCountRef.current
      const backlog = targetCount - displayedCount

      if (backlog <= 0) {
        stopFrameLoop()
        return
      }

      const now = performance.now()
      if (lastFrameTsRef.current === null) {
        lastFrameTsRef.current = now
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const commitIntervalMs = Math.min(MAX_COMMIT_INTERVAL_MS, config.minCommitIntervalMs)
      const frameIntervalMs = Math.max(0, now - lastFrameTsRef.current)
      if (frameIntervalMs < commitIntervalMs) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.12))
      lastFrameTsRef.current = now

      const idleMs = now - lastInputTsRef.current
      const inputActive = idleMs <= config.activeInputWindowMs
      const settling = !inputActive && idleMs >= config.settleAfterMs

      let revealChars: number
      if (steadyCps !== undefined) {
        const step = computeRevealStep(
          config,
          {
            backlog,
            chunkSizeEma: chunkSizeEmaRef.current,
            arrivalCpsEma: arrivalCpsEmaRef.current,
            emaCps: emaCpsRef.current,
            inputActive,
            settling,
            steadyCps,
          },
          dtSeconds,
        )
        revealChars = Math.min(step.revealChars, backlog)
      } else {
        // Same rAF queue drain as the silky markdown demo.
        revealChars = computeQueueReveal(backlog, frameIntervalMs)
      }

      // Performance guard: while degraded and the reply is offscreen, skip
      // the DOM commit — the backlog keeps accumulating and flushes when the
      // guard clears or the reply scrolls into view.
      if (holdBackRef.current?.() === true) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const speedOut = speedOutRef.current
      if (speedOut !== undefined && frameIntervalMs > 0) {
        const instantCps = (revealChars * 1000) / frameIntervalMs
        speedOut.current = speedOut.current * 0.92 + instantCps * 0.08
      }

      const nextCount = displayedCount + revealChars
      const segment = targetCharsRef.current.slice(displayedCount, nextCount).join('')
      if (segment) {
        const nextDisplayed = displayedContentRef.current + segment
        displayedContentRef.current = nextDisplayed
        displayedCountRef.current = nextCount
        setDisplayedContent(nextDisplayed)
      } else {
        displayedContentRef.current = targetContentRef.current
        displayedCountRef.current = targetCount
        setDisplayedContent(targetContentRef.current)
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
  }, [config, scheduleFrameWake, stopFrameLoop, clearWakeTimer, steadyCps])

  useEffect(() => {
    startFrameLoopRef.current = startFrameLoop
  }, [startFrameLoop])

  useEffect(() => {
    if (!enabled) {
      syncImmediate(content)
      return
    }

    const prevTargetContent = targetContentRef.current
    if (content === prevTargetContent) return

    const now = performance.now()
    const appendOnly = content.startsWith(prevTargetContent)

    if (!appendOnly) {
      syncImmediate(content)
      return
    }

    const appended = content.slice(prevTargetContent.length)
    const appendedChars = [...appended]
    const appendedCount = appendedChars.length

    targetContentRef.current = content
    targetCharsRef.current.push(...appendedChars)
    targetCountRef.current += appendedCount

    const hadSample = lastInputTsRef.current > 0
    const deltaChars = targetCountRef.current - lastInputCountRef.current
    const deltaMs = Math.max(1, now - lastInputTsRef.current)

    // Skip the first sample: lastInputTs starts at 0, so the interval would
    // be "time since page load" (or 1ms under fake timers) and poison the EMA.
    if (hadSample && deltaChars > 0) {
      const instantCps = (deltaChars * 1000) / deltaMs
      const normalizedInstantCps = clamp(instantCps, config.minCps, config.maxFlushCps * 3)
      const chunkEmaAlpha = 0.45
      chunkSizeEmaRef.current = chunkSizeEmaRef.current * (1 - chunkEmaAlpha) + appendedCount * chunkEmaAlpha
      arrivalCpsEmaRef.current = arrivalCpsEmaRef.current * (1 - chunkEmaAlpha) + normalizedInstantCps * chunkEmaAlpha
      emaCpsRef.current = emaCpsRef.current * (1 - config.emaAlpha) + normalizedInstantCps * config.emaAlpha
    }

    lastInputTsRef.current = now
    lastInputCountRef.current = targetCountRef.current

    startFrameLoop()
  }, [content, enabled, config, startFrameLoop, syncImmediate])

  useEffect(() => {
    return () => {
      stopScheduling()
    }
  }, [stopScheduling])

  return displayedContent
}
