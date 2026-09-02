/** Staged form state for the plugin-owned smooth-stream settings RPC. */

import { createSnapshotStore, type SnapshotStore } from './clientStore.ts'
import {
  DEFAULT_STREAM_DEBUG_TUNING,
  DEFAULT_STREAM_SETTINGS,
  type StreamDebugTuning,
  type StreamSettings,
} from '../settings.ts'
import type {
  StreamDebugSettingsView,
  StreamInstallationKind,
  StreamSettingsView,
} from '../settings-api.ts'
import type { SmoothStreamSettingsApi } from './smooth-stream-settings-api.ts'

/** What the smooth-stream card renders. It remains visible while its Host RPC loads. */
export interface SmoothStreamCardState {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  enabled: boolean
  controlScroll: boolean
  thinkAutoExpand: boolean
  debugEnabled: boolean
  debugTuning: StreamDebugTuning
  debugAvailable: boolean
  version: string | undefined
  installation: StreamInstallationKind
  canUpgrade: boolean
  upgrading: boolean
  upgradeFailed: boolean
  restartRequired: boolean
}

/** The registration-side face injected into the settings slot renderer. */
export interface SmoothStreamCardFace {
  hooks: {
    smoothStreamCard: SnapshotStore<SmoothStreamCardState>
  }
  edit: (patch: Partial<StreamSettings>) => void
  save: () => void
  discard: () => void
  reload: () => void
  upgrade: () => void
}

/** Bridges the plugin's protected Host interface onto a staged settings form. */
export class SmoothStreamCardController {
  private readonly store = createSnapshotStore<SmoothStreamCardState>(this.projection())
  private loaded: StreamSettingsView | undefined
  private loadedDebug: StreamDebugSettingsView | undefined
  private stagedBase: Pick<StreamSettings, 'enabled' | 'controlScroll' | 'thinkAutoExpand'> | undefined
  private stagedDebug: Pick<StreamSettings, 'debugEnabled' | 'debugTuning'> | undefined
  private saving = false
  private failed = false
  private upgrading = false
  private upgradeFailed = false
  private restartRequired = false
  private loadGeneration = 0
  private loadStatus: 'loading' | 'ready' | 'unavailable' = 'loading'

  constructor(private readonly api: SmoothStreamSettingsApi) {}

  /** Begin the background read after the card has been registered. */
  start(): void {
    void this.load()
  }

  /** Ignore a late response after the surrounding optional services unload. */
  stop(): void {
    this.loadGeneration += 1
  }

  /** Current card snapshot, also consumed by the streaming preference cell. */
  getSnapshot(): SmoothStreamCardState {
    return this.store.getSnapshot()
  }

  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /** Build the face consumed by the settings slot renderer. */
  inject(): SmoothStreamCardFace {
    return {
      hooks: { smoothStreamCard: this.store },
      edit: (patch) => {
        if (this.saving) return
        if (patch.enabled !== undefined || patch.controlScroll !== undefined || patch.thinkAutoExpand !== undefined) {
          this.stagedBase = {
            ...this.baseValues(),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.controlScroll === undefined ? {} : { controlScroll: patch.controlScroll }),
            ...(patch.thinkAutoExpand === undefined ? {} : { thinkAutoExpand: patch.thinkAutoExpand }),
          }
        }
        if (this.loadedDebug !== undefined && (patch.debugEnabled !== undefined || patch.debugTuning !== undefined)) {
          this.stagedDebug = {
            ...this.debugValues(),
            ...(patch.debugEnabled === undefined ? {} : { debugEnabled: patch.debugEnabled }),
            ...(patch.debugTuning === undefined ? {} : { debugTuning: { ...this.debugValues().debugTuning, ...patch.debugTuning } }),
          }
        }
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.stagedBase === undefined && this.stagedDebug === undefined && !this.failed) return
        this.stagedBase = undefined
        this.stagedDebug = undefined
        this.failed = false
        this.publish()
      },
      reload: () => { void this.load() },
      upgrade: () => { void this.upgrade() },
    }
  }

  private projection(): SmoothStreamCardState {
    return {
      status: this.loadStatus,
      writable: this.loaded?.writable ?? false,
      dirty: this.stagedBase !== undefined || this.stagedDebug !== undefined,
      saving: this.saving,
      failed: this.failed,
      ...this.baseValues(),
      ...this.debugValues(),
      debugAvailable: this.loadedDebug !== undefined,
      version: this.loaded?.version,
      installation: this.loaded?.installation ?? 'unmanaged',
      canUpgrade: this.loaded?.canUpgrade ?? false,
      upgrading: this.upgrading,
      upgradeFailed: this.upgradeFailed,
      restartRequired: this.restartRequired,
    }
  }

  private baseValues(): Pick<StreamSettings, 'enabled' | 'controlScroll' | 'thinkAutoExpand'> {
    return this.stagedBase ?? {
      enabled: this.loaded?.enabled ?? DEFAULT_STREAM_SETTINGS.enabled,
      controlScroll: this.loaded?.controlScroll ?? DEFAULT_STREAM_SETTINGS.controlScroll,
      thinkAutoExpand: this.loaded?.thinkAutoExpand ?? DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
    }
  }

  private debugValues(): Pick<StreamSettings, 'debugEnabled' | 'debugTuning'> {
    return this.stagedDebug ?? {
      debugEnabled: this.loadedDebug?.debugEnabled ?? DEFAULT_STREAM_SETTINGS.debugEnabled,
      debugTuning: this.loadedDebug?.tuning ?? DEFAULT_STREAM_DEBUG_TUNING,
    }
  }

  private valuesCache: StreamSettings | undefined
  private valuesSig: string | undefined

  /** Complete settings projection consumed by the live SettingsCell bridge.
    * Rebuilt only when the underlying fields change: handing
    * useSyncExternalStore a fresh reference per read trips React #321 even
    * when the content is identical, so the projection keeps its reference
    * across publishes until a field actually moves. debugTuning is compared
    * field-wise (its object identity churns with every rebuild). */
  values(): StreamSettings {
    const base = this.baseValues()
    const debug = this.debugValues()
    const sig = JSON.stringify([base, debug.debugEnabled, debug.debugTuning])
    const prev = this.valuesCache
    if (prev !== undefined && sig === this.valuesSig) return prev
    const tuningStable = prev !== undefined
      && prev.debugTuning.revealScale === debug.debugTuning.revealScale
      && prev.debugTuning.queuePressure === debug.debugTuning.queuePressure
      && prev.debugTuning.maxRevealCps === debug.debugTuning.maxRevealCps
      && prev.debugTuning.springStiffness === debug.debugTuning.springStiffness
      && prev.debugTuning.springDamping === debug.debugTuning.springDamping
      && prev.debugTuning.springMass === debug.debugTuning.springMass
      && prev.debugTuning.runwayPx === debug.debugTuning.runwayPx
      && prev.debugTuning.reserveResponseMs === debug.debugTuning.reserveResponseMs
      && prev.debugTuning.backpressureMinScale === debug.debugTuning.backpressureMinScale
    const built: StreamSettings = {
      ...base,
      debugEnabled: debug.debugEnabled,
      debugTuning: tuningStable ? prev.debugTuning : debug.debugTuning,
    }
    this.valuesSig = sig
    this.valuesCache = built
    return built
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.loadStatus = 'loading'
    this.loaded = undefined
    this.loadedDebug = undefined
    this.publish()
    try {
      const view = await this.api.read()
      if (generation !== this.loadGeneration) return
      this.loaded = view
      this.loadStatus = 'ready'
      this.publish()
      try {
        const debug = await this.api.readDebug()
        if (generation !== this.loadGeneration) return
        this.loadedDebug = debug
      } catch {
        if (generation !== this.loadGeneration) return
        // Older hosts expose the original settings endpoints only. Keep the
        // card usable and hide debug-only controls until the host is upgraded.
        this.loadedDebug = undefined
      }
    } catch {
      if (generation !== this.loadGeneration) return
      this.loaded = undefined
      this.loadedDebug = undefined
      this.loadStatus = 'unavailable'
    }
    this.publish()
  }

  private async save(): Promise<void> {
    if ((this.stagedBase === undefined && this.stagedDebug === undefined)
      || this.saving || this.loaded?.writable !== true) return
    const base = this.stagedBase
    const debug = this.stagedDebug
    this.saving = true
    this.failed = false
    this.publish()
    try {
      if (base !== undefined) {
        const combined = debug !== undefined && this.loadedDebug !== undefined
        this.loaded = await this.api.write(combined ? { ...base, ...debug } : base)
        this.stagedBase = undefined
        if (combined) {
          this.loadedDebug = {
            debugEnabled: debug.debugEnabled,
            tuning: { ...debug.debugTuning },
          }
          this.stagedDebug = undefined
        }
      }
      if (debug !== undefined && this.loadedDebug !== undefined && this.stagedDebug !== undefined) {
        this.loadedDebug = await this.api.writeDebug(debug)
        this.stagedDebug = undefined
      }
    } catch {
      this.failed = true
    }
    this.saving = false
    this.publish()
  }

  private async upgrade(): Promise<void> {
    if (this.loaded?.canUpgrade !== true || this.upgrading) return
    this.upgrading = true
    this.upgradeFailed = false
    this.restartRequired = false
    this.publish()
    try {
      const result = await this.api.upgrade()
      this.restartRequired = result.restartRequired
    } catch {
      this.upgradeFailed = true
    }
    this.upgrading = false
    this.publish()
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
