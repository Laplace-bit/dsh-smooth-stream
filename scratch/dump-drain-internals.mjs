#!/usr/bin/env node
/** Dumps the raw drain internals for the first tail frames (no interpretation). */
import {
  PRESET_CONFIG,
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  SETTLE_RAMP_TAU_S,
} from '../src/client/useSmoothStreamContent.ts'
import { DEFAULT_STREAM_DEBUG_TUNING } from '../src/settings.ts'

const config = PRESET_CONFIG.balanced
const FRAME_MS = 1000 / 60

function trace(cps, durationMs, chunkMs) {
  const chunks = []
  let t = 0
  while (t < durationMs) {
    t += chunkMs
    chunks.push({ tMs: t, chars: Math.max(1, Math.round((cps * chunkMs) / 1000)) })
  }
  return chunks
}

const chunks = trace(900, 4000, 25)
let targetCount = 0
let displayedCount = 0
let lastFrameTs = null
let queueDebt = 0
let settleCps = null
let lastDrainCps = 0
let lastInputTs = 0
let lastInputCount = 0
let emaCps = config.defaultCps
let inputComplete = false
let cursor = 0
let now = 0
const endMs = chunks[chunks.length - 1].tMs
let dumped = 0

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
  if (inputComplete) {
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
    if (dumped < 8) {
      dumped += 1
      console.log(
        `tail#${dumped} dt=${frameIntervalMs.toFixed(1)}ms backlog=${backlog} ema=${emaCps.toFixed(0)} `
        + `prev=${previousCps.toFixed(0)} target=${target.toFixed(0)} ramped=${ramped.toFixed(0)} `
        + `velocity=${velocity.toFixed(0)} lastDrain=${lastDrainCps.toFixed(0)} debt=${queueDebt.toFixed(2)} reveal=${revealChars}ch`,
      )
    }
  } else {
    const step = computeAdaptiveQueueStep(backlog, frameIntervalMs, queueDebt, 1, DEFAULT_STREAM_DEBUG_TUNING)
    revealChars = step.revealChars
    queueDebt = step.debt
    if (Math.abs(now - endMs) < FRAME_MS * 8) {
      console.log(`live  dt=${frameIntervalMs.toFixed(1)}ms backlog=${backlog} speed=${step.speedCps.toFixed(0)} reveal=${revealChars}ch`)
    }
  }
  displayedCount += revealChars
}
console.log(`config: flushCps=${config.flushCps} maxFlushCps=${config.maxFlushCps} settleRampTau=${SETTLE_RAMP_TAU_S}s`)
