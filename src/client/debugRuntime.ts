/**
 * Shared browser-side diagnostics state.
 *
 * The settings card owns persistence. This module is the live bridge used by
 * the renderer and the chat-side panel: renderer loops publish measurements,
 * while panel edits are staged through the settings-card controller.
 */

import { createSnapshotStore, type SnapshotStore } from './clientStore.ts'
import {
  DEFAULT_STREAM_DEBUG_TUNING,
  type StreamDebugTuning,
  type StreamSettings,
} from '../settings.ts'

export interface DebugMetrics {
  fps: number | null
  frameMs: number | null
  fpsDegraded: boolean
  streamActive: boolean
  streamBacklog: number
  streamSpeedCps: number
  streamTargetChars: number
  streamDisplayedChars: number
  followActive: boolean
  followLagPx: number
  followVelocityPxPerSec: number
  followReservePx: number
  followCapacityPx: number
  followRevealScale: number
  followFollowing: boolean
  followConstrained: boolean
  scrollTop: number | null
  scrollHeight: number | null
  clientHeight: number | null
  lastUpdatedMs: number | null
}

export interface DebugRuntimeState {
  available: boolean
  enabled: boolean
  writable: boolean
  dirty: boolean
  status: 'loading' | 'ready' | 'unavailable'
  tuning: StreamDebugTuning
  metrics: DebugMetrics
}

export type DebugSettingsPatch = Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuning'>>

export interface DebugPanelFace {
  hooks: {
    debugRuntime: SnapshotStore<DebugRuntimeState>
  }
  edit: (patch: DebugSettingsPatch) => void
  save: () => void
  discard: () => void
  reset: () => void
}

interface DebugSettingsActions {
  edit: (patch: DebugSettingsPatch) => void
  save: () => void
  discard: () => void
}

interface StreamMetric {
  backlog: number
  speedCps: number
  targetChars: number
  displayedChars: number
  active: boolean
  updatedAt: number
}

interface FollowMetric {
  lagPx: number
  velocityPxPerSec: number
  reservePx: number
  capacityPx: number
  revealScale: number
  following: boolean
  constrained: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  active: boolean
  updatedAt: number
}

const EMPTY_METRICS: DebugMetrics = {
  fps: null,
  frameMs: null,
  fpsDegraded: false,
  streamActive: false,
  streamBacklog: 0,
  streamSpeedCps: 0,
  streamTargetChars: 0,
  streamDisplayedChars: 0,
  followActive: false,
  followLagPx: 0,
  followVelocityPxPerSec: 0,
  followReservePx: 0,
  followCapacityPx: 0,
  followRevealScale: 1,
  followFollowing: false,
  followConstrained: false,
  scrollTop: null,
  scrollHeight: null,
  clientHeight: null,
  lastUpdatedMs: null,
}

const INITIAL_STATE: DebugRuntimeState = {
  available: false,
  enabled: false,
  writable: false,
  dirty: false,
  status: 'loading',
  tuning: { ...DEFAULT_STREAM_DEBUG_TUNING },
  metrics: EMPTY_METRICS,
}

const store = createSnapshotStore<DebugRuntimeState>(INITIAL_STATE)
const streamMetrics = new Map<string, StreamMetric>()
const followMetrics = new Map<HTMLElement, FollowMetric>()
let actions: DebugSettingsActions | undefined
let lastMetricPublish = 0

function resetMetrics(): void {
  streamMetrics.clear()
  followMetrics.clear()
  lastMetricPublish = 0
}

function resetRuntime(): void {
  actions = undefined
  resetMetrics()
  store.set({ ...INITIAL_STATE, metrics: EMPTY_METRICS })
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function sameTuning(left: StreamDebugTuning, right: StreamDebugTuning): boolean {
  return left.revealScale === right.revealScale
    && left.queuePressure === right.queuePressure
    && left.maxRevealCps === right.maxRevealCps
    && left.springStiffness === right.springStiffness
    && left.springDamping === right.springDamping
    && left.springMass === right.springMass
    && left.runwayPx === right.runwayPx
    && left.reserveResponseMs === right.reserveResponseMs
    && left.backpressureMinScale === right.backpressureMinScale
}

function currentMetrics(timestamp: number): DebugMetrics {
  let stream: StreamMetric | undefined
  for (const candidate of streamMetrics.values()) {
    if (stream === undefined || candidate.updatedAt > stream.updatedAt) stream = candidate
  }
  let follow: FollowMetric | undefined
  for (const candidate of followMetrics.values()) {
    if (follow === undefined || candidate.updatedAt > follow.updatedAt) follow = candidate
  }
  return {
    fps: store.getSnapshot().metrics.fps,
    frameMs: store.getSnapshot().metrics.frameMs,
    fpsDegraded: store.getSnapshot().metrics.fpsDegraded,
    streamActive: stream?.active ?? false,
    streamBacklog: stream?.backlog ?? 0,
    streamSpeedCps: stream?.speedCps ?? 0,
    streamTargetChars: stream?.targetChars ?? 0,
    streamDisplayedChars: stream?.displayedChars ?? 0,
    followActive: follow?.active ?? false,
    followLagPx: follow?.lagPx ?? 0,
    followVelocityPxPerSec: follow?.velocityPxPerSec ?? 0,
    followReservePx: follow?.reservePx ?? 0,
    followCapacityPx: follow?.capacityPx ?? 0,
    followRevealScale: follow?.revealScale ?? 1,
    followFollowing: follow?.following ?? false,
    followConstrained: follow?.constrained ?? false,
    scrollTop: follow?.scrollTop ?? null,
    scrollHeight: follow?.scrollHeight ?? null,
    clientHeight: follow?.clientHeight ?? null,
    lastUpdatedMs: timestamp,
  }
}

function publishMetrics(force = false): void {
  const timestamp = now()
  if (!force && timestamp - lastMetricPublish < 80) return
  lastMetricPublish = timestamp
  store.set({ ...store.getSnapshot(), metrics: currentMetrics(timestamp) })
}

export const debugRuntime = {
  store,

  getSnapshot(): DebugRuntimeState {
    return store.getSnapshot()
  },

  subscribe(listener: () => void): () => void {
    return store.subscribe(listener)
  },

  /** Whether hot-path instrumentation should do any work. */
  isEnabled(): boolean {
    return store.getSnapshot().enabled
  },

  tuning(): StreamDebugTuning {
    return store.getSnapshot().tuning
  },

  /** Production values remain untouched until the user explicitly enables diagnostics. */
  activeTuning(): StreamDebugTuning {
    return store.getSnapshot().enabled ? store.getSnapshot().tuning : DEFAULT_STREAM_DEBUG_TUNING
  },

  bindSettings(nextActions: DebugSettingsActions | undefined): () => void {
    actions = nextActions
    return () => {
      if (actions !== nextActions) return
      resetRuntime()
    }
  },

  syncSettings(input: {
    available?: boolean
    enabled: boolean
    writable: boolean
    dirty: boolean
    status: DebugRuntimeState['status']
    tuning?: StreamDebugTuning
  }): void {
    const current = store.getSnapshot()
    // Callers predating the Host capability flag are local diagnostics tests
    // and renderer probes; preserve their enabled behavior unless the wiring
    // explicitly reports that the RPC is unavailable.
    const available = input.available ?? true
    const enabled = available && input.enabled
    const availabilityChanged = current.available !== available
    const enabledChanged = current.enabled !== enabled
    if (availabilityChanged || enabledChanged) resetMetrics()
    const tuning = input.tuning === undefined
      ? current.tuning
      : { ...DEFAULT_STREAM_DEBUG_TUNING, ...input.tuning }
    if (
      current.available === available
      && current.enabled === enabled
      && current.writable === input.writable
      && current.dirty === input.dirty
      && current.status === input.status
      && sameTuning(current.tuning, tuning)
    ) return
    store.set({
      ...current,
      available,
      enabled,
      writable: input.writable,
      dirty: input.dirty,
      status: input.status,
      tuning,
      metrics: availabilityChanged || enabledChanged || !enabled ? EMPTY_METRICS : current.metrics,
    })
  },

  edit(patch: DebugSettingsPatch): void {
    const current = store.getSnapshot()
    const enabled = patch.debugEnabled ?? current.enabled
    const enabledChanged = current.enabled !== enabled
    if (enabledChanged) resetMetrics()
    const tuning = patch.debugTuning === undefined
      ? current.tuning
      : { ...current.tuning, ...patch.debugTuning }
    store.set({
      ...current,
      enabled,
      dirty: true,
      tuning,
      metrics: enabledChanged || !enabled ? EMPTY_METRICS : current.metrics,
    })
    actions?.edit({
      ...(patch.debugEnabled === undefined ? {} : { debugEnabled: patch.debugEnabled }),
      ...(patch.debugTuning === undefined ? {} : { debugTuning: tuning }),
    })
  },

  save(): void {
    actions?.save()
  },

  discard(): void {
    actions?.discard()
  },

  reset(): void {
    this.edit({ debugTuning: { ...DEFAULT_STREAM_DEBUG_TUNING } })
  },

  reportStream(id: string, metric: Omit<StreamMetric, 'updatedAt'> | null): void {
    if (!this.isEnabled()) return
    if (metric === null) streamMetrics.delete(id)
    else streamMetrics.set(id, { ...metric, updatedAt: now() })
    publishMetrics(metric === null)
  },

  reportFollow(port: HTMLElement, metric: Omit<FollowMetric, 'updatedAt'> | null): void {
    if (!this.isEnabled()) return
    if (metric === null) followMetrics.delete(port)
    else followMetrics.set(port, { ...metric, updatedAt: now() })
    publishMetrics(metric === null)
  },

  reportFps(fps: number, frameMs: number, degraded: boolean): void {
    if (!this.isEnabled()) return
    const current = store.getSnapshot()
    store.set({
      ...current,
      metrics: { ...current.metrics, fps, frameMs, fpsDegraded: degraded, lastUpdatedMs: now() },
    })
  },

  clearFps(): void {
    if (!this.isEnabled()) return
    const current = store.getSnapshot()
    store.set({
      ...current,
      metrics: {
        ...current.metrics,
        fps: null,
        frameMs: null,
        fpsDegraded: false,
        lastUpdatedMs: now(),
      },
    })
  },

  panelFace(): DebugPanelFace {
    return {
      hooks: { debugRuntime: store },
      edit: patch => { this.edit(patch) },
      save: () => { this.save() },
      discard: () => { this.discard() },
      reset: () => { this.reset() },
    }
  },

  resetRuntime(): void {
    resetRuntime()
  },
}
