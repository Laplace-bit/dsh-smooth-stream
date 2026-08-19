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
}

/** Defaults shared by the Host schema and the client-side fallback. */
export const DEFAULT_STREAM_CONFIG: StreamConfig = {
  mode: 'typewriter',
  preset: 'balanced',
  revealCharsPerSec: 80,
  scrollSpeedPxPerSec: 48,
  maxScrollSpeedPxPerSec: 1000,
}

/**
 * Window global the Host writes into the served index HTML. The browser boot
 * graph carries no per-entry config, so this inline script is the only
 * Host-to-client configuration channel for a composed web plugin.
 */
export const STREAM_BOOT_GLOBAL = '__DSH_SMOOTH_STREAM_CONFIG__'
