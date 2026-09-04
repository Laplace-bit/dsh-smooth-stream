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

/** Runtime knobs exposed only while the diagnostics switch is enabled. */
export interface StreamDebugTuning {
  /** Multiplier applied to the reveal cadence (1 = preset default). */
  revealScale: number
  /** Multiplier for backlog pressure in the adaptive reveal queue. */
  queuePressure: number
  /** Upper bound for reveal cadence, in characters per second. */
  maxRevealCps: number
  /** Spring stiffness used by the conversation follower. */
  springStiffness: number
  /** Spring damping used by the conversation follower. */
  springDamping: number
  /** Spring mass used by the conversation follower. */
  springMass: number
  /** Predictive runway before the fixed conversation chrome, in pixels. */
  runwayPx: number
  /** Response time for opening/closing the predictive runway, in ms. */
  reserveResponseMs: number
  /** Lowest reveal multiplier when visual lag fills the safe paint room. */
  backpressureMinScale: number
}

/** Defaults preserve the production engine exactly. */
export const DEFAULT_STREAM_DEBUG_TUNING: StreamDebugTuning = {
  revealScale: 1,
  queuePressure: 0.85,
  maxRevealCps: 600,
  springStiffness: 130,
  springDamping: 24,
  springMass: 1,
  runwayPx: 72,
  reserveResponseMs: 180,
  backpressureMinScale: 0.55,
}

/**
 * Preferences a user may set. Deliberately separate from {@link StreamConfig}
 * because the two change at different times: composition-time values go
 * through the boot global, a live UI edit goes through the protected plugin RPC.
 */
/** How the typewriter reveal responds to the OS reduced-motion preference. */
export type StreamMotionPreference =
  /** Follow the OS preference: reduced-motion users get raw text (accessibility first). */
  | 'auto'
  /** Always run the smoothing engine, ignoring the OS preference. */
  | 'force-smooth'
  /** Always render raw text, ignoring the OS preference. */
  | 'force-reduced'

export interface StreamSettings {
  /**
   * Whether this plugin replaces and wraps Harness conversation renderers.
   * Off returns all rendering ownership to the built-in UI.
   */
  enabled: boolean
  /**
   * Whether this plugin also takes over conversation bottom-follow. Off leaves
   * scroll ownership to the Harness; text reveal still runs.
   */
  controlScroll: boolean
  /**
   * Whether the typewriter reveal honors the OS reduced-motion preference.
   * `auto` preserves the accessibility-first default; `force-smooth` keeps the
   * smoothing engine on machines where a system-wide reduce-motion switch
   * (or a forced browser flag) would otherwise bypass it.
   */
  motionPreference: StreamMotionPreference  /**
   * Whether a reasoning ("Think") block auto-expands while it is the
   * streaming tail. Off keeps the block collapsed — the user can still open
   * it by hand — and stops the running state from re-owning the disclosure.
   */
  thinkAutoExpand: boolean
  /** Whether the live renderer diagnostics panel is enabled. */
  debugEnabled: boolean
  /** Values edited by the diagnostics panel. */
  debugTuning: StreamDebugTuning
}

/** Defaults shared by the Host schema and the client-side fallback. */
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  enabled: true,
  controlScroll: true,
  motionPreference: 'auto',  thinkAutoExpand: true,
  debugEnabled: false,
  debugTuning: DEFAULT_STREAM_DEBUG_TUNING,
}
