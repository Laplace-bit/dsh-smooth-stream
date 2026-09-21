#!/usr/bin/env node
/**
 * Isolates WHY the producer-complete tail steps up in speed.
 *
 * Three arms over the same arrival rate:
 *   A uniform      : flat chunk cadence (no coalescing) — isolates the branch switch
 *   B coalesced    : provider-style coalesced bursts — adds the arrival-EMA seed
 *   C uniform+cap  : uniform arrival above the live reveal ceiling (maxRevealCps)
 *
 * Prints the reveal velocity for the last 8 live frames and the first 8 tail
 * frames so the discontinuity is visible directly.
 */
import {
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  SETTLE_RAMP_TAU_S,
} from '../src/client/useSmoothStreamContent.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const config = PRESET_CONFIG.balanced
const FRAME_MS = 1000 / 60

/** Arrival trace of `{tMs, chars}` chunks. */
function uniformTrace(cps, durationMs, chunkMs = 25) {
  const chunks = []
  let t = 0
  while (t < durationMs) {
    t += chunkMs
    chunks.push({ tMs: t, chars: Math.max(1, Math.round((cps * chunkMs) / 1000)) })
  }
  return chunks
}

function coalescedTrace(cps, durationMs, gapMs = 25) {
  const chunks = []
  let t = 0
  let n = 0
  while (t < durationMs) {
    t += gapMs
    n += 1
    // Provider-style: three deltas land together every fourth gap.
    const weight = n % 4 === 0 ? 3 : 1
    chunks.push({ tMs: t, chars: Math.max(1, Math.round((cps * gapMs * weight) / 1000)) })
  }
  return chunks
}

function simulate(chunks, { label }) {
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
  let inputComplete = false
  let cursor = 0
  let now = 0
  const endMs = chunks.length === 0 ? 0 : chunks[chunks.length - 1].tMs
  const frames = []

  while (now < endMs + 3000) {
    now += FRAME_MS
    let appended = 0
    while (cursor < chunks.length && chunks[cursor].tMs <= now) {
      appended += chunks[cursor].chars
      targetCount += chunks[cursor].chars
      cursor += 1
    }
    if (appended > 0) {
      const hadSample = lastInputTs > 0
      const deltaChars = targetCount - lastInputCount
      const deltaMs = Math.max(1, now - lastInputTs)
      if (hadSample && deltaChars > 0) {
        const instantCps = (deltaChars * 1000) / deltaMs
        const normalized = Math.min(config.maxFlushCps * 3, Math.max(config.minCps, instantCps))
        arrivalCpsEma = arrivalCpsEma * 0.55 + normalized * 0.45
        emaCps = emaCps * (1 - config.emaAlpha) + normalized * config.emaAlpha
      }
      lastInputTs = now
      lastInputCount = targetCount
    }
    if (!inputComplete && cursor >= chunks.length) inputComplete = true

    const backlog = targetCount - displayedCount
    if (backlog <= 0) {
      if (inputComplete) break
      continue
    }
    if (lastFrameTs === null) {
      lastFrameTs = now
      continue
    }
    const frameIntervalMs = Math.max(0, now - lastFrameTs)
    const dtSeconds = Math.max(0.001, Math.min(frameIntervalMs / 1000, 0.12))
    lastFrameTs = now

    let revealChars
    let mode
    if (inputComplete) {
      mode = 'tail'
      const previousCps = lastDrainCps > 0 ? lastDrainCps : Math.max(config.minCps, emaCps)
      const target = settleCps ?? computeCompletionDrain(config, backlog, previousCps)
      settleCps = target
      const ramped = previousCps + (target - previousCps) * (1 - Math.exp(-dtSeconds / SETTLE_RAMP_TAU_S))
      const velocity = Math.min(target, Math.max(previousCps, ramped))
      lastDrainCps = Math.min(target, ramped)
      const accumulated = Math.max(0, queueDebt) + velocity * dtSeconds
      revealChars = Math.min(backlog, Math.floor(accumulated))
      queueDebt = revealChars >= backlog ? 0 : accumulated - revealChars
      if (revealChars >= backlog) lastDrainCps = 0
    } else {
      mode = 'live'
      const step = computeAdaptiveQueueStep(backlog, frameIntervalMs, queueDebt, 1, DEFAULT_STREAM_DEBUG_TUNING)
      revealChars = step.revealChars
      queueDebt = step.debt
    }
    displayedCount += revealChars
    frames.push({ t: now, mode, backlog, revealChars, instantCps: (revealChars * 1000) / frameIntervalMs })
  }

  const tailStart = frames.findIndex(frame => frame.mode === 'tail')
  const boundary = tailStart === -1 ? frames.length : tailStart
  const liveTail = frames.slice(Math.max(0, boundary - 8), boundary)
  const tailHead = frames.slice(boundary, boundary + 8)
  const median = list => {
    const sorted = [...list].sort((a, b) => a - b)
    return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
  }
  const step = median(tailHead.map(frame => frame.instantCps)) / Math.max(1, median(liveTail.map(frame => frame.instantCps)))
  console.log(`\n== ${label} ==`)
  console.log(`live last 8 : ${liveTail.map(f => `${f.revealChars}ch/${f.instantCps.toFixed(0)}cps[b${f.backlog}]`).join(' ')}`)
  console.log(`tail first 8: ${tailHead.map(f => `${f.revealChars}ch/${f.instantCps.toFixed(0)}cps[b${f.backlog}]`).join(' ')}`)
  console.log(`backlog at completion ${tailHead[0]?.backlog ?? 0} chars · step ${step.toFixed(2)}x · tail frames ${frames.length - boundary}`)
  const peak = Math.max(0, ...frames.map(frame => frame.instantCps))
  console.log(`peak visible speed ${peak.toFixed(0)} cps (live ceiling maxRevealCps=${DEFAULT_STREAM_DEBUG_TUNING.maxRevealCps}, tail clamp maxFlushCps=${config.maxFlushCps}, ema clamp ${config.maxFlushCps * 3})`)
  return { step, backlogAtComplete: tailHead[0]?.backlog ?? 0, peak }
}

console.log('arrival patterns (balanced preset, 60fps frames)')
simulate(uniformTrace(400, 4000), { label: 'A uniform 400cps arrival (below live ceiling)' })
simulate(uniformTrace(900, 4000), { label: 'B uniform 900cps arrival (above live ceiling)' })
simulate(coalescedTrace(900, 4000), { label: 'C coalesced 900cps-equivalent arrival' })
simulate(coalescedTrace(2000, 4000), { label: 'D coalesced 2000cps-equivalent arrival' })
