/** Shared wire vocabulary for the plugin-owned settings RPC channel. */

/** Dedicated, loopback-only RPC channel registered by the Host half. */
export const STREAM_SETTINGS_RPC_CHANNEL = '/smooth-stream'

/** Endpoints accepted by {@link STREAM_SETTINGS_RPC_CHANNEL}. */
export const STREAM_SETTINGS_RPC = {
  read: 'settings.read',
  write: 'settings.write',
  upgrade: 'plugin.upgrade',
} as const

/** How the active profile supplied this plugin. */
export type StreamInstallationKind = 'npm' | 'development' | 'unmanaged'

/** Redacted, plugin-owned configuration state returned to the browser. */
export interface StreamSettingsView {
  /** Version of the package currently running in the Host process. */
  version: string
  /** Source class of this package in the active profile. */
  installation: StreamInstallationKind
  /** Whether the Host settings provider permits a write. */
  writable: boolean
  /** Current resolved preference. */
  thinkAutoExpand: boolean
  /** Whether a fixed npm update command is safe to offer. */
  canUpgrade: boolean
}

/** Successful package update acknowledgement; loading the new code needs a restart. */
export interface StreamUpgradeView {
  restartRequired: true
}
