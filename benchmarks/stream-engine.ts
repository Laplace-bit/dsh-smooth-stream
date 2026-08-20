import {
  computeAdaptiveQueueStep,
  computeCompletionDrain,
  computeQueueReveal,
  PRESET_CONFIG,
} from '../src/client/useSmoothStreamContent.ts'
import {
  computeFollowReserve,
  computeFollowRevealScale,
  computeFollowStep,
  FOLLOW_SETTLE_EPSILON_PX,
} from '../src/client/teleprompterGlide.ts'

interface ThroughputResult {
  medianMs: number
  operations: number
  operationsPerSecond: number
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right)
  return ordered[Math.floor(ordered.length / 2)] ?? 0
}

function measureThroughput(operation: (index: number) => void): ThroughputResult {
  const operations = 250_000
  const samples: number[] = []
  for (let run = 0; run < 9; run += 1) {
    const started = performance.now()
    for (let index = 0; index < operations; index += 1) operation(index)
    const elapsed = performance.now() - started
    if (run >= 2) samples.push(elapsed)
  }
  const medianMs = median(samples)
  return {
    medianMs: round(medianMs, 3),
    operations,
    operationsPerSecond: Math.round(operations / (medianMs / 1000)),
  }
}

function settleSpring(initialLagPx: number, frameMs: number): {
  frames: number
  settledMs: number
  finalLagPx: number
} {
  let lag = initialLagPx
  let velocityPxPerSec = 0
  let frames = 0
  while ((lag > FOLLOW_SETTLE_EPSILON_PX || velocityPxPerSec > 0.5) && frames < 10_000) {
    const step = computeFollowStep(frameMs, { lag, speedEma: 180, velocityPxPerSec })
    lag = Math.max(0, lag - step.advancePx)
    velocityPxPerSec = step.velocityPxPerSec
    frames += 1
  }
  return { frames, settledMs: round(frames * frameMs, 1), finalLagPx: round(lag, 4) }
}

const queueBacklogs = [8, 32, 128, 512, 2048].map(backlog => ({
  backlog,
  charsPerFrameAt60Hz: computeQueueReveal(backlog, 1000 / 60),
  speedCps: round(computeAdaptiveQueueStep(backlog, 1000 / 60, 0).speedCps, 1),
}))

const completionBacklogs = [32, 128, 512, 2048].map(backlog => ({
  backlog,
  balancedCompletionCps: round(computeCompletionDrain(PRESET_CONFIG.balanced, backlog), 1),
}))

const springSettle = [16, 48, 96, 192].map(initialLagPx => ({
  initialLagPx,
  at60Hz: settleSpring(initialLagPx, 1000 / 60),
  at120Hz: settleSpring(initialLagPx, 1000 / 120),
}))

const pressure = [0, 12, 24, 36, 48].map(lagPx => ({
  lagPx,
  revealScaleAt48PxCapacity: round(computeFollowRevealScale(lagPx, 48), 3),
}))

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: process.env.BENCHMARK_CPU ?? 'record manually when publishing results',
  },
  scope: 'Pure TypeScript reveal and follow decisions only; excludes React, Markdown parsing, DOM layout, paint, and network time.',
  throughput: {
    queueStep: measureThroughput(index => {
      computeAdaptiveQueueStep(32 + index % 2016, 1000 / 60, (index % 100) / 100)
    }),
    springStep: measureThroughput(index => {
      computeFollowStep(1000 / 60, {
        lag: 16 + index % 176,
        speedEma: 180,
        velocityPxPerSec: index % 240,
      })
    }),
  },
  queueBacklogs,
  completionBacklogs,
  springSettle,
  reservePxByRevealRate: [90, 180, 360, 600].map(speedCps => ({
    speedCps,
    reservePx: round(computeFollowReserve(speedCps), 2),
  })),
  pressure,
}

console.log(JSON.stringify(result, null, 2))
