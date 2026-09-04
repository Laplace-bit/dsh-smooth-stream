/** Browser adapter for the Host-owned smooth-stream settings RPC. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { StreamDebugTuning, StreamSettings } from '../settings.ts'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
  type StreamDebugSettingsView,
  type StreamSettingsView,
  type StreamUpgradeView,
} from '../settings-api.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function settingsView(value: unknown): StreamSettingsView {
  const data = record(value)
  if (data === undefined
    || typeof data.version !== 'string'
    || !['npm', 'development', 'unmanaged'].includes(data.installation as string)
    || typeof data.writable !== 'boolean'
    || typeof data.enabled !== 'boolean'
    || !['auto', 'force-smooth', 'force-reduced'].includes(data.motionPreference as string)    || typeof data.thinkAutoExpand !== 'boolean'
    || typeof data.canUpgrade !== 'boolean') {
    throw new Error('dsh-smooth-stream: malformed settings response')
  }
  return data as unknown as StreamSettingsView
}

function upgradeView(value: unknown): StreamUpgradeView {
  const data = record(value)
  if (data?.restartRequired !== true) throw new Error('dsh-smooth-stream: malformed update response')
  return { restartRequired: true }
}

function debugSettingsView(value: unknown): StreamDebugSettingsView {
  const data = record(value)
  const tuning = record(data?.tuning)
  if (data === undefined
    || typeof data.debugEnabled !== 'boolean'
    || tuning === undefined
    || typeof tuning.revealScale !== 'number'
    || typeof tuning.queuePressure !== 'number'
    || typeof tuning.maxRevealCps !== 'number'
    || typeof tuning.springStiffness !== 'number'
    || typeof tuning.springDamping !== 'number'
    || typeof tuning.springMass !== 'number'
    || typeof tuning.runwayPx !== 'number'
    || typeof tuning.reserveResponseMs !== 'number'
    || typeof tuning.backpressureMinScale !== 'number') {
    throw new Error('dsh-smooth-stream: malformed debug settings response')
  }
  return {
    debugEnabled: data.debugEnabled,
    tuning: tuning as unknown as StreamDebugTuning,
  }
}

function accepted(result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Narrow client contract consumed by the staged settings-card controller. */
export interface SmoothStreamSettingsApi {
  read(): Promise<StreamSettingsView>
  write(settings: Pick<StreamSettings, 'enabled' | 'motionPreference' | 'thinkAutoExpand' | 'autoCollapse'> & Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuning'>>): Promise<StreamSettingsView>  readDebug(): Promise<StreamDebugSettingsView>
  writeDebug(settings: Pick<StreamSettings, 'debugEnabled' | 'debugTuning'>): Promise<StreamDebugSettingsView>
  upgrade(): Promise<StreamUpgradeView>
}

/** Build the typed facade over the generic Connection RPC service. */
export function createSmoothStreamSettingsApi(connection: ConnectionHandle): SmoothStreamSettingsApi {
  return {
    async read(): Promise<StreamSettingsView> {
      return settingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.read, {})))
    },
    async write(settings: Pick<StreamSettings, 'enabled' | 'motionPreference' | 'thinkAutoExpand' | 'autoCollapse'> & Partial<Pick<StreamSettings, 'debugEnabled' | 'debugTuning'>>): Promise<StreamSettingsView> {      return settingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.write,
        {
          enabled: settings.enabled,
          motionPreference: settings.motionPreference,          thinkAutoExpand: settings.thinkAutoExpand,
          ...(settings.debugEnabled === undefined || settings.debugTuning === undefined
            ? {}
            : { debugEnabled: settings.debugEnabled, debugTuning: settings.debugTuning }),
        },
      )))
    },
    async readDebug(): Promise<StreamDebugSettingsView> {
      return debugSettingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.debugRead,
        {},
      )))
    },
    async writeDebug(settings: Pick<StreamSettings, 'debugEnabled' | 'debugTuning'>): Promise<StreamDebugSettingsView> {
      return debugSettingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.debugWrite,
        { debugEnabled: settings.debugEnabled, tuning: settings.debugTuning },
      )))
    },
    async upgrade(): Promise<StreamUpgradeView> {
      return upgradeView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.upgrade, {})))
    },
  }
}
