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

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
    minCps: 20,
    settleAfterMs: 360,
    settleDrainMaxMs: 520,
    settleDrainMinMs: 160,
    targetBufferMs: 56,
  },
}

/** Pressure curve from the reference stream renderer. */
export const QUEUE_BASE_SPEED_CPS = 90
export const QUEUE_ACCEL_EXPONENT = 1.25
export const QUEUE_PRESSURE_FACTOR = 0.85
export const QUEUE_MAX_SPEED_CPS = 600
/** Hard cap on how far display may trail a live stream, in characters. */
export const LIVE_LAG_CHAR_CEILING = 32
const CATCHUP_SECONDS = 0.15

export const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value))
}

/**
 * Reference pressure-buffer reveal for a frame that starts without debt.
 * @param backlog - Unrevealed characters.
 * @param dtMs - Frame delta in ms.
 * @returns Characters to reveal this frame.
 */
export function computeQueueReveal(backlog: number, dtMs: number): number {
  if (backlog <= 0 || dtMs <= 0) return 0
  return computeAdaptiveQueueStep(backlog, dtMs, 0).revealChars
}

export interface AdaptiveQueueStep {
  readonly revealChars: number
  readonly debt: number
  readonly speedCps: number
}

/** Float-debt queue integration from `ultimate_stream_physics_scroller.html`. */
export function computeAdaptiveQueueStep(
  backlog: number,
  dtMs: number,
  debt: number,
  revealScale = 1,
): AdaptiveQueueStep {
  if (backlog <= 0 || dtMs <= 0) return { revealChars: 0, debt: 0, speedCps: 0 }
  const speedCps = Math.min(
    QUEUE_MAX_SPEED_CPS,
    QUEUE_BASE_SPEED_CPS + Math.pow(backlog, QUEUE_ACCEL_EXPONENT) * QUEUE_PRESSURE_FACTOR,
  )
  const effectiveScale = clamp(revealScale, 0.05, 1)
  const accumulated = Math.max(0, debt) + speedCps * effectiveScale * (dtMs / 1000)
  const revealChars = Math.min(backlog, Math.floor(accumulated))
  return { revealChars, debt: revealChars >= backlog ? 0 : accumulated - revealChars, speedCps }
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

/** Fixed velocity that closes a producer-complete queue within its deadline. */
export function computeCompletionDrain(
  config: StreamSmoothingPresetConfig,
  backlog: number,
): number {
  if (backlog <= 0) return 0
  const drainTargetMs = clamp(backlog * 8, config.settleDrainMinMs, config.settleDrainMaxMs)
  const deadlineCps = (backlog * 1000) / drainTargetMs
  return Math.max(
    deadlineCps,
    computeSettleDrain(config, { backlog, inputActive: false, settling: true }),
  )
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
  /** The producer has completed; drain queued text without live backpressure. */
  inputComplete?: boolean
  preset?: StreamSmoothingPreset
  /** Performance guard veto: while true, reveal commits are held back. */
  shouldHoldBack?: (() => boolean) | undefined
  /**
   * Fixed reveal rate in chars/s. When set, the reveal runs at this steady
   * pace while the input streams (instead of tracking the arrival rate) and
   * drains an inferred idle backlog at {@link SETTLE_DRAIN_MULTIPLIER}.
   * Explicit producer completion still uses the bounded completion drain.
   */
  steadyCps?: number | undefined
  /**
   * Seed for the arrival-rate EMA. When omitted, the preset's `defaultCps`
   * is used. The live rate then tracks observed arrival; this is not a cap.
   */
  defaultCps?: number | undefined
  /** Written each commit with the live arrival-rate EMA for the follow lerp. */
  speedCpsRef?: { current: number } | undefined
  /** Live multiplier from the follow spring when safe visual lag is filling. */
  revealScaleRef?: { current: number } | undefined
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
  {
    enabled = true,
    inputComplete = false,
    preset = 'balanced',
    shouldHoldBack,
    steadyCps,
    defaultCps,
    speedCpsRef,
    revealScaleRef,
  }: UseSmoothStreamContentOptions = {},
): string {
  const config = PRESET_CONFIG[preset]
  const seedCps = defaultCps ?? config.defaultCps
  // A fast provider can fill the first Host render with a large batch. Start
  // an enabled stream behind that batch so it still enters the reveal queue;
  // disabled (settled/history) content must remain immediate.
  const initialContent = enabled ? '' : content
  const [displayedContent, setDisplayedContent] = useState(initialContent)

  const displayedContentRef = useRef(initialContent)
  const displayedCountRef = useRef(countChars(initialContent))
  const targetContentRef = useRef(initialContent)
  const targetCharsRef = useRef([...initialContent])
  const targetCountRef = useRef(countChars(initialContent))

  const emaCpsRef = useRef(seedCps)
  const lastInputTsRef = useRef(0)
  const lastInputCountRef = useRef(countChars(initialContent))
  const chunkSizeEmaRef = useRef(1)
  const arrivalCpsEmaRef = useRef(seedCps)

  const rafRef = useRef<number | null>(null)
  const lastFrameTsRef = useRef<number | null>(null)
  const queueDebtRef = useRef(0)
  const settleCpsRef = useRef<number | null>(null)
  const holdBackRef = useRef(shouldHoldBack)
  const speedOutRef = useRef(speedCpsRef)
  speedOutRef.current = speedCpsRef
  const revealScaleOutRef = useRef(revealScaleRef)
  revealScaleOutRef.current = revealScaleRef
  const inputCompleteRef = useRef(inputComplete)
  inputCompleteRef.current = inputComplete

  useEffect(() => {
    holdBackRef.current = shouldHoldBack
  }, [shouldHoldBack])

  const stopFrameLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    lastFrameTsRef.current = null
  }, [])

  const startFrameLoopRef = useRef<() => void>(() => {})

  const syncImmediate = useCallback(
    (nextContent: string) => {
      stopFrameLoop()
      const chars = [...nextContent]
      const now = performance.now()
      targetContentRef.current = nextContent
      targetCharsRef.current = chars
      targetCountRef.current = chars.length
      displayedContentRef.current = nextContent
      displayedCountRef.current = chars.length
      queueDebtRef.current = 0
      settleCpsRef.current = null
      const speedOut = speedOutRef.current
      if (speedOut !== undefined) speedOut.current = seedCps
      setDisplayedContent(nextContent)
      emaCpsRef.current = seedCps
      chunkSizeEmaRef.current = 1
      arrivalCpsEmaRef.current = seedCps
      lastInputTsRef.current = now
      lastInputCountRef.current = chars.length
    },
    [seedCps, stopFrameLoop],
  )

  // Producer completion is authoritative. Publish the accumulated source in
  // the same commit instead of leaving a visible typewriter tail after the
  // Agent has already stopped; the conversation follower still glides any
  // resulting layout height before paint.
  useLayoutEffect(() => {
    if (!enabled || !inputComplete || displayedContentRef.current === content) return
    syncImmediate(content)
  }, [content, enabled, inputComplete, syncImmediate])

  const startFrameLoop = useCallback(() => {
    if (rafRef.current !== null) return

    const tick = (now: number) => {
      const targetCount = targetCountRef.current
      const displayedCount = displayedCountRef.current
      const backlog = targetCount - displayedCount

      if (backlog <= 0) {
        queueDebtRef.current = 0
        settleCpsRef.current = null
        const speedOut = speedOutRef.current
        if (speedOut !== undefined) speedOut.current = seedCps
        stopFrameLoop()
        return
      }

      if (lastFrameTsRef.current === null) {
        lastFrameTsRef.current = now
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      const frameIntervalMs = Math.max(0, now - lastFrameTsRef.current)
      const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.12))
      lastFrameTsRef.current = now

      const idleMs = now - lastInputTsRef.current
      const producerComplete = inputCompleteRef.current
      const inputActive = !producerComplete && idleMs <= config.activeInputWindowMs
      const settling = producerComplete || (!inputActive && idleMs >= config.settleAfterMs)
      if (!producerComplete) settleCpsRef.current = null

      let revealChars: number
      let revealSpeedCps: number
      let nextQueueDebt = 0
      if (producerComplete) {
        // Backpressure protects live layout. Once input has ended, retaining
        // that scale only makes a completed response keep typing onscreen.
        // Keep one drain velocity for the whole completion tail. Recomputing
        // it from the shrinking backlog creates an exponential slow tail.
        const settleCps = settleCpsRef.current ?? computeCompletionDrain(config, backlog)
        settleCpsRef.current = settleCps
        const accumulated = Math.max(0, queueDebtRef.current) + settleCps * dtSeconds
        revealChars = Math.min(backlog, Math.floor(accumulated))
        revealSpeedCps = settleCps
        nextQueueDebt = revealChars >= backlog ? 0 : accumulated - revealChars
      } else if (steadyCps !== undefined) {
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
        revealSpeedCps = frameIntervalMs > 0 ? (revealChars * 1000) / frameIntervalMs : 0
      } else {
        const step = computeAdaptiveQueueStep(
          backlog,
          frameIntervalMs,
          queueDebtRef.current,
          revealScaleOutRef.current?.current ?? 1,
        )
        revealChars = step.revealChars
        revealSpeedCps = step.speedCps
        nextQueueDebt = step.debt
      }

      // Performance guard: while degraded and the reply is offscreen, skip
      // the DOM commit — the backlog keeps accumulating and flushes when the
      // guard clears or the reply scrolls into view.
      if (holdBackRef.current?.() === true) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }

      queueDebtRef.current = nextQueueDebt

      const speedOut = speedOutRef.current
      if (speedOut !== undefined) speedOut.current = revealSpeedCps

      if (revealChars <= 0) {
        rafRef.current = requestAnimationFrame(tick)
        return
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
  }, [config, stopFrameLoop, steadyCps])

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
    settleCpsRef.current = null

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
      stopFrameLoop()
    }
  }, [stopFrameLoop])

  return displayedContent
}
