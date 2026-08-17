/**
 * User-owned settings for the smooth-stream plugin, exposed to the Host
 * settings service and edited from the Web Settings "plugin configuration"
 * page. This is the runtime-editable complement to {@link StreamConfig}: that
 * contract is composed at load and bridged once through the boot global, while
 * these preferences live in the durable user-settings document and take effect
 * live.
 */

/** Settings namespace registered by the Host and served through the plugin RPC. */
export const STREAM_SETTINGS_NS = 'smooth-stream'

/**
 * Preferences a user may set. Deliberately separate from {@link StreamConfig}
 * because the two change at different times: composition-time values go
 * through the boot global, a live UI edit goes through the protected plugin RPC.
 */
export interface StreamSettings {
  /**
   * Whether a reasoning ("Think") block auto-expands while it is the
   * streaming tail. Off keeps the block collapsed — the user can still open
   * it by hand — and stops the running state from re-owning the disclosure.
   */
  thinkAutoExpand: boolean
}

/** Defaults shared by the Host schema and the client-side fallback. */
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  thinkAutoExpand: true,
}
