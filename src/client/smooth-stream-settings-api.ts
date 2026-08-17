/** Browser adapter for the Host-owned smooth-stream settings RPC. */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import {
  STREAM_SETTINGS_RPC,
  STREAM_SETTINGS_RPC_CHANNEL,
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
    || typeof data.thinkAutoExpand !== 'boolean'
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

function accepted(result: Awaited<ReturnType<ConnectionHandle['rpc']['call']>>): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Narrow client contract consumed by the staged settings-card controller. */
export interface SmoothStreamSettingsApi {
  read(): Promise<StreamSettingsView>
  write(thinkAutoExpand: boolean): Promise<StreamSettingsView>
  upgrade(): Promise<StreamUpgradeView>
}

/** Build the typed facade over the generic Connection RPC service. */
export function createSmoothStreamSettingsApi(connection: ConnectionHandle): SmoothStreamSettingsApi {
  return {
    async read(): Promise<StreamSettingsView> {
      return settingsView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.read, {})))
    },
    async write(thinkAutoExpand: boolean): Promise<StreamSettingsView> {
      return settingsView(accepted(await connection.rpc.call(
        STREAM_SETTINGS_RPC_CHANNEL,
        STREAM_SETTINGS_RPC.write,
        { thinkAutoExpand },
      )))
    },
    async upgrade(): Promise<StreamUpgradeView> {
      return upgradeView(accepted(await connection.rpc.call(STREAM_SETTINGS_RPC_CHANNEL, STREAM_SETTINGS_RPC.upgrade, {})))
    },
  }
}
