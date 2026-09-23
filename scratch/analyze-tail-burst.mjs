#!/usr/bin/env node
/**
 * Replays the shipped reveal loop (`useSmoothStreamContent`'s tick body) against
 * synthetic LLM arrival traces and prints the per-frame reveal velocity so the
 * live phase and the producer-complete tail can be compared directly.
 *
 * The pure pacing functions are imported from the real source, so the numbers
 * below are the shipped constants, not a re-implementation.
 */
import {
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  computeSettleDrain,
  SETTLE_RAMP_TAU_S,
} from '../src/client/useSmoothStreamContent.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const PRESET = process.env.PRESET ?? 'balanced'
const FPS = Number(process.env.FPS ?? 60)
const FRAME_MS = 1000 / FPS
const config = PRESET_CONFIG[PRESET]

/** Simple xorshift so runs are reproducible. */
let seed = Number(process.env.SEED ?? 7)
function rand() {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return ((seed >>> 0) % 100000) / 100000
}

/**
 * Build an arrival trace: `{ tMs, totalChars }` events, plus the completion time.
 * Mirrors a provider stream: many small deltas, a few coalesced bursts.
 */
function buildTrace({ cps, durationMs, burstEvery = 7 }) {
  const events = []
  let total = 0
  let t = 0
  let sinceBurst = 0
  while (t < durationMs) {
    // 8-45ms inter-chunk gap; a burst every `burstEvery` chunks coalesces.
    const gap = 8 + rand() * 37
    t += gap
    sinceBurst += 1
    const burst = sinceBurst >= burstEvery
    if (burst) sinceBurst = 0
    const chars = Math.max(1, Math.round((cps * gap) / 1000 * (burst ? 2.6 : 1)))
    total += chars
    events.push({ tMs: t, totalChars: total })
  }
  return { events, totalChars: total, endMs: t }
}

/**
 * The tick body of `useSmoothStreamContent`, driven by an event trace.
 * Returns one record per frame plus a completion summary.
 */
function simulate({ events, totalChars, endMs }) {
  // --- hook refs ---
  let targetCount = 0
  let displayedCount = 0
  let lastFrameTs = null
  let queueDebt = 0
  let settleCps = null
  let lastDrainCps = 0
  let lastInputTs = 0
  let lastInputCount = 0
  let emaCps = config.defaultCps
  let arrivalCpsEma = config.defaultCps
  let chunkSizeEma = 1
  let inputComplete = false

  const frames = []
  let cursor = 0
  let now = 0
  let completeAt = null
  let drainedAt = null

  while (now < endMs + 4000) {
    now += FRAME_MS

    // Deliver every arrival event due by this frame.
    let appended = 0
    while (cursor < events.length && events[cursor].tMs <= now) {
      const next = events[cursor]
      appended += next.totalChars - targetCount
      targetCount = next.totalChars
      cursor += 1
    }
    if (appended > 0) {
      const hadSample = lastInputTs > 0
      const deltaChars = targetCount - lastInputCount
      const deltaMs = Math.max(1, now - lastInputTs)
      if (hadSample && deltaChars > 0) {
        const instantCps = (deltaChars * 1000) / deltaMs
        const normalized = Math.min(config.maxFlushCps * 3, Math.max(config.minCps, instantCps))
        chunkSizeEma = chunkSizeEma * 0.55 + appended * 0.45
        arrivalCpsEma = arrivalCpsEma * 0.55 + normalized * 0.45
        emaCps = emaCps * (1 - config.emaAlpha) + normalized * config.emaAlpha
      }
      lastInputTs = now
      lastInputCount = targetCount
    }
    if (!inputComplete && cursor >= events.length) {
      inputComplete = true
      completeAt = now
    }

    // --- frame body ---
    const backlog = targetCount - displayedCount
    if (backlog <= 0) {
      if (drainedAt === null && completeAt !== null) drainedAt = now
      // loop would stop; keep spinning the clock for the trace only
      if (completeAt !== null) break
      continue
    }
    if (lastFrameTs === null) {
      lastFrameTs = now
      continue
    }
    const frameIntervalMs = Math.max(0, now - lastFrameTs)
    const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.12))
    lastFrameTs = now
    const idleMs = now - lastInputTs
    const inputActive = !inputComplete && idleMs <= config.activeInputWindowMs
    const settling = inputComplete || (!inputActive && idleMs >= config.settleAfterMs)
    if (!inputComplete) settleCps = null

    let revealChars
    let revealSpeedCps
    let nextQueueDebt = 0
    let mode
    if (inputComplete) {
      mode = 'completion'
      const previousCps = lastDrainCps > 0 ? lastDrainCps : Math.max(config.minCps, emaCps)
      const target = settleCps ?? computeCompletionDrain(config, backlog, previousCps)
      settleCps = target
      const ramped = previousCps + (target - previousCps) * (1 - Math.exp(-dtSeconds / SETTLE_RAMP_TAU_S))
      const settleVelocity = Math.min(target, Math.max(previousCps, ramped))
      lastDrainCps = Math.min(target, ramped)
      const accumulated = Math.max(0, queueDebt) + settleVelocity * dtSeconds
      revealChars = Math.min(backlog, Math.floor(accumulated))
      revealSpeedCps = settleVelocity
      nextQueueDebt = revealChars >= backlog ? 0 : accumulated - revealChars
      if (revealChars >= backlog) lastDrainCps = 0
    } else {
      mode = inputActive ? 'live-active' : settling ? 'live-settling' : 'live-idle'
      const step = computeAdaptiveQueueStep(
        backlog,
        frameIntervalMs,
        queueDebt,
        1,
        DEFAULT_STREAM_DEBUG_TUNING,
      )
      revealChars = step.revealChars
      revealSpeedCps = step.speedCps
      nextQueueDebt = step.debt
    }

    queueDebt = nextQueueDebt
    displayedCount += revealChars
    frames.push({
      t: now,
      mode,
      backlog,
      revealChars,
      speedCps: revealChars > 0 ? (revealChars * 1000) / frameIntervalMs : 0,
      engineCps: revealSpeedCps,
    })
    if (displayedCount >= targetCount && completeAt !== null) {
      drainedAt = now
      break
    }
  }
  return { frames, totalChars, endMs, completeAt, drainedAt }
}

function summarize(label, trace) {
  const live = trace.frames.filter(frame => frame.mode !== 'completion')
  const tail = trace.frames.filter(frame => frame.mode === 'completion')
  const mean = values => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length)
  const median = values => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((left, right) => left - right)
    return sorted[Math.floor(sorted.length / 2)]
  }
  const liveCps = live.map(frame => frame.speedCps)
  const tailCps = tail.map(frame => frame.speedCps)
  const backlogAtComplete = tail.length > 0 ? tail[0].backlog : 0
  console.log(`\n== ${label} (${PRESET} @ ${FPS}fps) ==`)
  console.log(`arrival: ${Math.round(trace.totalChars / (trace.endMs / 1000))} cps mean, ${trace.totalChars} chars in ${Math.round(trace.endMs)}ms`)
  console.log(`live   : ${live.length} frames, median ${median(liveCps).toFixed(0)} cps, mean ${mean(liveCps).toFixed(0)} cps, max ${Math.max(0, ...liveCps).toFixed(0)} cps`)
  console.log(`tail   : ${tail.length} frames, median ${median(tailCps).toFixed(0)} cps, mean ${mean(tailCps).toFixed(0)} cps, first ${tailCps[0]?.toFixed(0) ?? 0} cps`)
  console.log(`backlog when the producer completed: ${backlogAtComplete} chars; tail duration ${tail.length === 0 ? 0 : Math.round(tail[tail.length - 1].t - tail[0].t)}ms`)
  console.log(`speed step at completion: ${(median(tailCps) / Math.max(1, median(liveCps))).toFixed(2)}x the live median`)
  const first = tail.slice(0, 6).map(frame => `${frame.t.toFixed(0)}ms ${frame.revealChars}ch ${frame.speedCps.toFixed(0)}cps (backlog ${frame.backlog})`)
  console.log(`first tail frames: ${first.join(' | ')}`)
}

const scenarios = [
  ['fast sustained (600cps, 4s)', { cps: 600, durationMs: 4000 }],
  ['slow steady (80cps, 6s)', { cps: 80, durationMs: 6000 }],
  ['bursty (250cps, 5s)', { cps: 250, durationMs: 5000, burstEvery: 4 }],
  ['think-then-answer fast tail (400cps, 3s)', { cps: 400, durationMs: 3000 }],
]

for (const [label, spec] of scenarios) {
  seed = Number(process.env.SEED ?? 7)
  summarize(label, simulate(buildTrace(spec)))
}

console.log('\n-- reference constants --')
console.log(`balanced: flushCps=${config.flushCps} maxFlushCps=${config.maxFlushCps} settleAfterMs=${config.settleAfterMs} settleDrain=[${config.settleDrainMinMs},${config.settleDrainMaxMs}]ms`)
console.log(`maxRevealCps=${DEFAULT_STREAM_DEBUG_TUNING.maxRevealCps} queuePressure=${DEFAULT_STREAM_DEBUG_TUNING.queuePressure}`)
for (const backlog of [32, 128, 300, 512, 1024]) {
  console.log(`computeCompletionDrain(backlog=${backlog}) = ${computeCompletionDrain(config, backlog, 200).toFixed(0)} cps -> ${(backlog / computeCompletionDrain(config, backlog, 200) * 1000).toFixed(0)}ms`)
}
console.log(`computeSettleDrain(backlog=1000) = ${computeSettleDrain(config, { backlog: 1000, inputActive: false, settling: true }).toFixed(0)} cps`)
