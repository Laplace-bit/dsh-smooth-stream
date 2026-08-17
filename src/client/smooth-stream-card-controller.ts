/** Staged form state for the plugin-owned smooth-stream settings RPC. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { DEFAULT_STREAM_SETTINGS } from '../settings.ts'
import type { StreamInstallationKind, StreamSettingsView } from '../settings-api.ts'
import type { SmoothStreamSettingsApi } from './smooth-stream-settings-api.ts'

/** What the smooth-stream card renders. It remains visible while its Host RPC loads. */
export interface SmoothStreamCardState {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  thinkAutoExpand: boolean
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
  edit: (value: boolean) => void
  save: () => void
  discard: () => void
  reload: () => void
  upgrade: () => void
}

/** Bridges the plugin's protected Host interface onto a staged settings form. */
export class SmoothStreamCardController {
  private readonly store = createSnapshotStore<SmoothStreamCardState>(this.projection())
  private loaded: StreamSettingsView | undefined
  private staged: boolean | undefined
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
      edit: (value) => {
        this.staged = value
        this.failed = false
        this.publish()
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged === undefined && !this.failed) return
        this.staged = undefined
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
      dirty: this.staged !== undefined,
      saving: this.saving,
      failed: this.failed,
      thinkAutoExpand: this.staged ?? this.loaded?.thinkAutoExpand ?? DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
      version: this.loaded?.version,
      installation: this.loaded?.installation ?? 'unmanaged',
      canUpgrade: this.loaded?.canUpgrade ?? false,
      upgrading: this.upgrading,
      upgradeFailed: this.upgradeFailed,
      restartRequired: this.restartRequired,
    }
  }

  private async load(): Promise<void> {
    const generation = ++this.loadGeneration
    this.loadStatus = 'loading'
    this.loaded = undefined
    this.publish()
    try {
      const view = await this.api.read()
      if (generation !== this.loadGeneration) return
      this.loaded = view
      this.loadStatus = 'ready'
    } catch {
      if (generation !== this.loadGeneration) return
      this.loaded = undefined
      this.loadStatus = 'unavailable'
    }
    this.publish()
  }

  private async save(): Promise<void> {
    if (this.staged === undefined || this.saving || this.loaded?.writable !== true) return
    const value = this.staged
    this.saving = true
    this.failed = false
    this.publish()
    try {
      this.loaded = await this.api.write(value)
      this.staged = undefined
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
