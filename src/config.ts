/**
 * Shared plugin configuration contract. The Host half defines the
 * Schemastery schema over this shape (defaults live here so both halves stay
 * symmetric); the client half falls back to the same defaults when the Host
 * boot-config bridge is absent (client-only composition).
 */

import type { StreamSmoothingPreset } from './client/useSmoothStreamContent.ts'

/** Legacy render-mode value retained so existing overlays remain valid. */
export type StreamMode = 'typewriter' | 'teleprompter'

/** Plugin configuration validated by the Host schema and bridged to the browser half. */
export interface StreamConfig {
  /** Compatibility field; both values use the current adaptive reveal engine. */
  readonly mode: StreamMode
  /** Smoothing preset for the reveal cadence. */
  readonly preset: StreamSmoothingPreset
  /**
   * Unused at runtime; kept so existing overlays load. Live reveal tracks
   * observed arrival and ignores this seed.
   */
  readonly revealCharsPerSec: number
  /**
   * Unused at runtime; kept so existing overlays load. Follow is a
   * smooth-damp, not a cruise speed.
   */
  readonly scrollSpeedPxPerSec: number
  /** Unused at runtime; retained so existing overlays continue to load. */
  readonly maxScrollSpeedPxPerSec: number
  /**
   * Whether the follow engine writes the conversation scroll position on
   * dsh 0.2.x. Defaults to false: the 0.2.x kernel's native bottom-follow is
   * already smooth, while the engine — tuned for the 0.1.x bottom-anchored
   * flow and its turn-status-row geometry — adds entrance-window jumps on
   * the 0.2.x DOM during reply streaming. Set `controlScroll: true` in the
   * overlay config to restore the takeover. dsh 0.1.x ignores this key; its
   * user-owned toggle (default on) stays the authority there.
   */
  readonly controlScroll: boolean
}

/** Defaults shared by the Host schema and the client-side fallback. */
export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  mode: 'typewriter',
  preset: 'silky',
  revealCharsPerSec: 80,
  scrollSpeedPxPerSec: 48,
  maxScrollSpeedPxPerSec: 1000,
  controlScroll: false,
}

/**
 * Window global the Host writes into the served index HTML. The browser boot
 * graph carries no per-entry config, so this inline script is the only
 * Host-to-client configuration channel for a composed web plugin.
 */
export const STREAM_BOOT_GLOBAL = '__DSH_SMOOTH_STREAM_CONFIG__'
