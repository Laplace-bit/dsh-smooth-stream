/**
 * Conversation-port follow while an assistant reply streams.
 *
 * A sub-stepped spring physics engine drives a float `animatedH`, rather
 * than restarting native smooth-scroll animations as every glyph lands.
 * Remaining lag rides a small compositor transform while the real scrollport
 * stays at its floor. The transform is bounded by the measured paint gap
 * before conversation chrome. This follower:
 *
 * - marks programmatic writes via `data-follow-owned` for compatible hosts;
 * - sets `overflow-anchor: none` so CSS scroll-anchoring does not snap;
 * - restores `animatedH` in a ResizeObserver (before paint) so a layout
 *   pass cannot flash a snapped frame;
 * - expresses safe lag as a compositor transform on message rows;
 * - opens a speed-adaptive layout runway before fast output wraps, preserving
 *   the reference spring constants at every reveal speed;
 * - catches up any lag that cannot fit before turn status / composer chrome,
 *   so fixed chrome never has to counter-shift and the host stays at-bottom;
 * - never clips or overlays streamed text.
 *
 * A real reader gesture receives the effective visual position before the
 * transform clears. Lifecycle completion instead settles at the floor.
 *
 * Directional wheel/touch intent unpins immediately; pointer/key input falls
 * back to an upward scroll delta from the engine's own written position. A
 * reader release re-acquires only after returning to the real floor.
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'
import { DEFAULT_STREAM_DEBUG_TUNING, type StreamDebugTuning } from '../settings.ts'
import { debugRuntime } from './debugRuntime.ts'

/**
 * Programmatic follow marker retained for hosts that recognize external
 * scroll ownership. Current Harness also sees the write land at the floor.
 */
const FOLLOW_OWNED_ATTR = 'data-follow-owned'

/** Physics parameters from `ultimate_stream_physics_scroller.html`. */
export const FOLLOW_SPRING_STIFFNESS = 130
export const FOLLOW_SPRING_DAMPING = 24
export const FOLLOW_SPRING_MASS = 1
export const FOLLOW_SPRING_SUBSTEPS = 4
export const FOLLOW_SPRING_MAX_STEP_MS = 32

/** Minimum visible room for one ordinary line-wrap impulse. */
export const FOLLOW_RESERVE_MIN_PX = 31

/** Reveal speeds at or below this are idle; no predictive room is held. */
export const FOLLOW_RESERVE_IDLE_CPS = 20

/** Reveal-speed range produced by the pressure-buffer typewriter. */
/** Retained for consumers that tune the old pressure threshold. */
export const FOLLOW_RESERVE_MIN_CPS = 90
export const FOLLOW_RESERVE_MAX_CPS = 600

/** Time constant for opening/closing predictive paint room. */
export const FOLLOW_RESERVE_RESPONSE_MS = 180

/**
 * The reference engine clamps physical time to one 32ms visual interval.
 * Replaying a 250ms main-thread stall in one paint teleports the transcript;
 * leaving the remaining distance in the spring makes the next frames catch up
 * smoothly instead.
 */
export const FOLLOW_MAX_FRAME_MS = 32

/** Retained as the neutral reveal-speed seed for follow hosts. */
export const FOLLOW_SPEED_REF_CPS = 35

/** Reader-return / still-pinned boundary, matching ChatView + the demo. */
export const FOLLOW_SLACK_PX = 25

/**
 * Fallback upward scroll distance that releases the pin when the browser does
 * not expose a directional wheel/touch event. Directional intent releases
 * immediately even if the follow write erases the small physical delta.
 */
export const FOLLOW_UNPIN_GESTURE_PX = 8

/** A reader-released follow only re-acquires at the actual floor. */
export const FOLLOW_REPIN_PX = 1

/** ChatView's <=25px bottom band remains host-pinned; release beyond it. */
export const FOLLOW_HOST_RELEASE_PX = FOLLOW_SLACK_PX + 1

/** Sub-pixel paint guard before status/composer chrome. */
export const FOLLOW_PAINT_GUARD_PX = 1

/**
 * Maximum predictive paint room before status/composer chrome. The
 * feed-forward phase leads the real floor by up to one wrapped line, so the
 * runway must hold steady lag + one line + guard (35 + 26 + 8 ≈ 72) or the
 * leading shift gets clipped against chrome at the wrap cadence.
 */
export const FOLLOW_STATUS_RUNWAY_PX = 72

/**
 * Duration of completion runway retirement. The final pad is visible motion:
 * its shrinking floor brings the transcript down to its natural resting
 * position. 1.5s keeps the default 72px runway at 48px/s (0.8px per 60Hz
 * frame), matching the configured default reading-follow velocity instead of
 * the old 160ms / 450px/s staircase that looked like repeated completion
 * jumps.
 */
export const FOLLOW_RUNWAY_RETIRE_MS = 1500

/** How long a gesture keeps `isUserInteracting` so the next scroll can unpin. */
export const FOLLOW_GESTURE_MS = 800

/** Sub-pixel settle threshold; clearing below this cannot produce a visible rebound. */
export const FOLLOW_SETTLE_EPSILON_PX = 0.25

/**
 * How long the completion settle waits for the HOST's completion cascade —
 * status-row swap, think auto-collapse, metrics-tail mount — to stop moving
 * the scroll extent before the follower releases the port. Releasing earlier
 * hands a still-changing layout to the host's hard floor-snap, which paints
 * each host action as a single-frame slam of the whole transcript.
 */
export const FOLLOW_SETTLE_QUIET_MS = 240

/**
 * Ceiling for the flow's completion pad. The pad backs the floor so the
 * pinned viewport can follow the reading anchor through host completion
 * commits (row swaps/insertions); capping it bounds the below-fold blank
 * space a long conversation accumulates.
 */
export const FOLLOW_SETTLE_PAD_CAP_PX = 2 * FOLLOW_STATUS_RUNWAY_PX

/** Retained visual-motion budget for compatibility with diagnostics/tests. */
export const FOLLOW_CATCHUP_MAX_STEP_PX = 8

/**
 * Max painted-shift change per frame, in px. A line-wrap adds one line height
 * (24-28px) to the floor in a single layout pass; letting the shift follow it
 * instantly paints that whole step as a hard jump of the newest line. Capping
 * the shift's per-frame change spreads the step across a few frames so the
 * line glides in (slow start) instead of snapping.
 */
/**
 * Per-frame bound on the DECAY side of the painted shift only (runway
 * retirement and settle). The growth side is wrap compensation and must stay
 * unlimited — see the clamp site in `applyVisual`.
 */
export const FOLLOW_PAINT_SHIFT_MAX_STEP_PX = 8

/** Runway size emitted by bundles before the 72px predictive runway. */
const LEGACY_RUNWAY_PX = 48

/** Lowest reveal rate retained while the spring is short on paint room. */
export const FOLLOW_REVEAL_MIN_SCALE = 0.55

/** Safe-lag occupancy band over which reveal pressure is progressively reduced. */
export const FOLLOW_BACKPRESSURE_START_RATIO = 0.1
export const FOLLOW_BACKPRESSURE_FULL_RATIO = 0.75

/** Slow release prevents the reveal rate from oscillating around each wrap. */
export const FOLLOW_BACKPRESSURE_RELEASE_MS = 240

/** Effective-scroll acceleration budget, in px/ms². */
export const FOLLOW_TRAJECTORY_ACCELERATION = 0.00022

/** Leave one line of phase range inside the visible runway. */
export const FOLLOW_TRAJECTORY_PHASE_PX = 32

/** Keep adaptive runway retirement from exposing an oversized chrome gap. */
export const FOLLOW_TRAJECTORY_MIN_LAG_PX = 20

/** Phase-centering response; slow enough to preserve continuous velocity. */
export const FOLLOW_TRAJECTORY_CENTERING_MS = 120

const GESTURE_EVENTS = [
  'wheel',
  'touchstart',
  'touchmove',
  'touchend',
  'touchcancel',
  'pointerdown',
  'keydown',
] as const

/** Visible runway needed for the current reveal pressure. */
export function computeFollowReserve(
  speedCps: number,
  runwayPx = FOLLOW_STATUS_RUNWAY_PX,
): number {
  const available = Math.max(0, runwayPx)
  if (available <= 0) return 0
  if (speedCps <= FOLLOW_RESERVE_IDLE_CPS) return 0
  const normalized = Math.min(1, Math.max(0, (
    speedCps - FOLLOW_RESERVE_IDLE_CPS
  ) / (FOLLOW_RESERVE_MAX_CPS - FOLLOW_RESERVE_IDLE_CPS)))
  const minimum = Math.min(available, FOLLOW_RESERVE_MIN_PX)
  return minimum + normalized * (available - minimum)
}

export interface FollowTrajectoryInput {
  readonly positionPx: number
  readonly velocityPxPerMs: number
  readonly targetPx: number
  readonly targetVelocityPxPerMs: number
  readonly minLagPx: number
  readonly maxLagPx: number
  /** Real scroll floor used to turn logical position into a painted shift. */
  readonly paintFloorPx?: number
}

export interface FollowRevealPhaseOptions {
  readonly seedCharsPerLine?: number
  readonly seedLineHeightPx?: number
}

export interface FollowRevealPhase {
  readonly targetPx: number
  readonly phase: number
  readonly charsPerLine: number
  readonly lineHeightPx: number
}

/**
 * Character-domain feed-forward for the stepped layout floor. Callers only
 * provide committed reveal progress and the measured floor; wrap capacity and
 * line height stay local to this module and adapt when a real wrap lands.
 */
export class FollowRevealPhaseTracker {
  private charsPerLine: number
  private lineHeightPx: number
  private floorPx: number | null = null
  private wrapRevealCount = 0
  private lastRevealCount = 0

  constructor({
    seedCharsPerLine = 50,
    seedLineHeightPx = 26,
  }: FollowRevealPhaseOptions = {}) {
    this.charsPerLine = Math.max(1, seedCharsPerLine)
    this.lineHeightPx = Math.max(1, seedLineHeightPx)
  }

  advance(floorPx: number, revealedChars: number): FollowRevealPhase {
    const nextFloor = Math.max(0, floorPx)
    const nextRevealCount = Math.max(0, revealedChars)
    if (this.floorPx === null || nextRevealCount < this.lastRevealCount) {
      this.floorPx = nextFloor
      this.wrapRevealCount = nextRevealCount
      this.lastRevealCount = nextRevealCount
      return this.snapshot(nextFloor, 0)
    }

    const floorDelta = nextFloor - this.floorPx
    const lineStepThreshold = Math.max(4, this.lineHeightPx * 0.5)
    if (floorDelta >= lineStepThreshold) {
      const wrappedLines = Math.max(1, Math.round(floorDelta / this.lineHeightPx))
      const sampledLineHeight = floorDelta / wrappedLines
      const revealedSinceWrap = nextRevealCount - this.wrapRevealCount
      if (revealedSinceWrap >= this.charsPerLine * 0.5) {
        const sampledCharsPerLine = revealedSinceWrap / wrappedLines
        const alpha = 0.25
        this.charsPerLine += (sampledCharsPerLine - this.charsPerLine) * alpha
        this.lineHeightPx += (sampledLineHeight - this.lineHeightPx) * alpha
        this.wrapRevealCount = nextRevealCount
      } else {
        // A flow sibling can grow without the text arm committing a glyph.
        // Treat that as an unrelated layout event so its height is not folded
        // into the next text-wrap capacity sample.
        this.wrapRevealCount = nextRevealCount
      }
    } else if (floorDelta <= -lineStepThreshold) {
      this.wrapRevealCount = nextRevealCount
    }

    this.floorPx = nextFloor
    this.lastRevealCount = nextRevealCount
    const phase = Math.min(1, Math.max(
      0,
      (nextRevealCount - this.wrapRevealCount) / this.charsPerLine,
    ))
    return this.snapshot(nextFloor, phase)
  }

  private snapshot(floorPx: number, phase: number): FollowRevealPhase {
    return {
      targetPx: floorPx + this.lineHeightPx * phase,
      phase,
      charsPerLine: this.charsPerLine,
      lineHeightPx: this.lineHeightPx,
    }
  }
}

/** Advance a continuous effective scroll position behind a stepped floor. */
export function computeFollowTrajectoryStep(
  dtMs: number,
  input: FollowTrajectoryInput,
): { positionPx: number, shiftPx: number, velocityPxPerMs: number } {
  if (dtMs <= 0) {
    return {
      positionPx: input.positionPx,
      shiftPx: Math.max(0, (input.paintFloorPx ?? input.targetPx) - input.positionPx),
      velocityPxPerMs: input.velocityPxPerMs,
    }
  }
  const elapsedMs = Math.min(FOLLOW_MAX_FRAME_MS, dtMs)
  const currentLagPx = input.targetPx - input.positionPx
  const maxLagPx = Math.max(0, input.maxLagPx)
  const minLagPx = Math.min(Math.max(0, input.minLagPx), maxLagPx)
  const centerLagPx = (minLagPx + maxLagPx) / 2
  const desiredVelocity = Math.max(
    0,
    input.targetVelocityPxPerMs
      + (currentLagPx - centerLagPx) / FOLLOW_TRAJECTORY_CENTERING_MS,
  )
  const maxVelocityChange = FOLLOW_TRAJECTORY_ACCELERATION * elapsedMs
  const velocityPxPerMs = desiredVelocity >= input.velocityPxPerMs
    ? Math.min(desiredVelocity, input.velocityPxPerMs + maxVelocityChange)
    : Math.max(desiredVelocity, input.velocityPxPerMs - maxVelocityChange)
  const minPosition = input.targetPx - maxLagPx
  const maxPosition = input.targetPx - minLagPx
  // The frame budget follows controlled velocity rather than a refresh-rate
  // dependent pixel constant. `elapsedMs` is already capped at 32ms, so a
  // stalled browser cannot replay an unbounded jump when it catches up.
  const frameAdvancePx = velocityPxPerMs * elapsedMs
  const boundedPositionPx = Math.min(
    maxPosition,
    Math.max(minPosition, input.positionPx + frameAdvancePx),
  )
  const positionPx = Math.max(input.positionPx, boundedPositionPx)
  return {
    positionPx,
    shiftPx: Math.max(0, (input.paintFloorPx ?? input.targetPx) - positionPx),
    velocityPxPerMs,
  }
}

/**
 * Reveal-rate multiplier needed to retain one-wrap headroom for the spring.
 * Throttling starts only after a quarter of the safe transform is occupied;
 * a constrained paint lands at the minimum immediately so the next reveal
 * commit cannot keep feeding an already-full visual buffer.
 */
export function computeFollowRevealScale(
  lagPx: number,
  capacityPx: number,
  constrained = false,
  tuning: StreamDebugTuning = DEFAULT_STREAM_DEBUG_TUNING,
): number {
  if (constrained) return tuning.backpressureMinScale
  if (!Number.isFinite(capacityPx)) return 1
  if (capacityPx <= 0) return lagPx > 0 ? tuning.backpressureMinScale : 1
  const ratio = Math.min(1, Math.max(0, lagPx / capacityPx))
  if (ratio >= FOLLOW_BACKPRESSURE_FULL_RATIO) return tuning.backpressureMinScale
  const progress = Math.min(1, Math.max(0, (
    ratio - FOLLOW_BACKPRESSURE_START_RATIO
  ) / (FOLLOW_BACKPRESSURE_FULL_RATIO - FOLLOW_BACKPRESSURE_START_RATIO)))
  const eased = progress * progress * (3 - 2 * progress)
  return 1 - (1 - tuning.backpressureMinScale) * eased
}

export interface FollowGlideInput {
  /** How far the interpolated top trails the floor, in px. */
  readonly lag: number
  /** Observed reveal rate, retained for the public follow-step contract. */
  readonly speedEma: number
  /** Physics velocity carried from the previous frame, in px/s. */
  readonly velocityPxPerSec?: number
}

export interface FollowGlideStep {
  /** Pixels to advance the floating content extent this frame. */
  readonly advancePx: number
  /** Applied lerp fraction, for tests. */
  readonly lerpStep: number
  /** Physics velocity to carry into the next frame, in px/s. */
  readonly velocityPxPerSec: number
}

/** Semi-implicit spring integration with four substeps per <=32ms slice. */
export function computeFollowStep(
  dtMs: number,
  input: FollowGlideInput,
  tuning: StreamDebugTuning = DEFAULT_STREAM_DEBUG_TUNING,
): FollowGlideStep {
  if (input.lag <= 0.1 || dtMs <= 0) {
    return { advancePx: 0, lerpStep: 0, velocityPxPerSec: 0 }
  }
  let lag = input.lag
  let velocity = Math.max(0, input.velocityPxPerSec ?? 0)
  const elapsedMs = Math.min(FOLLOW_MAX_FRAME_MS, dtMs)
  const slices = Math.max(1, Math.ceil(elapsedMs / FOLLOW_SPRING_MAX_STEP_MS))
  const subDt = elapsedMs / 1000 / slices / FOLLOW_SPRING_SUBSTEPS
  for (let slice = 0; slice < slices; slice += 1) {
    for (let substep = 0; substep < FOLLOW_SPRING_SUBSTEPS; substep += 1) {
      const acceleration = (
        tuning.springStiffness * lag - tuning.springDamping * velocity
      ) / tuning.springMass
      velocity = Math.max(0, velocity + acceleration * subDt)
      const advance = velocity * subDt
      if (advance >= lag) return { advancePx: input.lag, lerpStep: 1, velocityPxPerSec: 0 }
      lag -= advance
    }
  }
  const advancePx = input.lag - lag
  return { advancePx, lerpStep: advancePx / input.lag, velocityPxPerSec: velocity }
}

/** Element whose resize signals flow growth for the before-paint restore. */
function resizeProxyOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector('[data-chat-transcript]') ?? port.querySelector('[data-chat-flow]')
}

/**
 * Outermost message surfaces; nested tool rows ride their parent.
 *
 * Another plugin may insert its own element as a flow sibling of the Chat rows
 * (meow-memory's fold bar is one).
 * Such a row carries no `data-chat-anchor-key`, so selecting only anchored
 * rows would shift the conversation while leaving the foreign row at its
 * natural offset, letting the shifted rows paint over it. Every direct flow
 * child therefore rides the same transform, keeping the visual order of the
 * column intact.
 */
export function shiftSurfacesOf(port: HTMLElement): HTMLElement[] {
  const transcript = port.querySelector<HTMLElement>('[data-chat-transcript]')
  if (transcript !== null) return [transcript]
  const anchored = [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .filter(row => row.parentElement?.closest('[data-chat-anchor-key]') === null)
  const flow = port.querySelector<HTMLElement>('[data-chat-flow]')
  if (flow === null) return anchored
  const status = turnStatusOf(port)
  const anchoredSet = new Set(anchored)
  // One document-order pass: an anchored row, or a foreign child that contains
  // no anchored row of its own (a wrapper around real rows would double-shift
  // the rows inside it).
  return [...flow.children].filter((child): child is HTMLElement =>
    child instanceof HTMLElement
    && child !== status
    && (anchoredSet.has(child) || child.querySelector('[data-chat-anchor-key]') === null))
}

function currentShiftOf(element: HTMLElement): number {
  return Number(
    /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
  )
}

/* An open fixed tooltip (role="tooltip") inside a surface is the only reason a
 * naive translate would misalign content during the follow shift: the applied
 * transform turns the surface into the tooltip's containing block and drags
 * the bubble off its anchor. Rather than re-derive viewport coordinates every
 * frame (a fragile engine that needed four follow-up fixes), hold the affected
 * surface untransformed while a tooltip is open. A tooltip exists in the DOM
 * only during hover, so the transient un-shifted row is invisible to a reader
 * and matches the release 0.4.0 feel; the shift resumes on the next frame once
 * it closes. */

function setDirectShift(element: HTMLElement, px: number): void {
  if (Math.abs(px) > 0.01) {
    if (
      Math.abs(currentShiftOf(element) - px) <= 0.01
      && element.style.willChange === 'transform'
      && element.style.clipPath === ''
    ) return
    element.style.transform = `translate3d(0, ${px}px, 0)`
    element.style.willChange = 'transform'
  } else {
    if (element.style.transform === '' && element.style.willChange === '' && element.style.clipPath === '') return
    element.style.transform = ''
    element.style.willChange = ''
  }
  element.style.clipPath = ''
}

function setShift(element: HTMLElement, px: number): void {
  // Guard: while an open fixed tooltip lives on the surface, hold it
  // untransformed (see the comment above). When the shift is zero the tooltip
  // cannot detach, so skip the subtree scan entirely and keep the fast path.
  if (Math.abs(px) > 0.01 && element.querySelector('[role="tooltip"]') !== null) {
    setDirectShift(element, 0)
    return
  }
  setDirectShift(element, px)
}

function turnStatusOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector<HTMLElement>(
    '[data-chat-turn-status], [data-chat-flow] > [role="status"]',
  )
}

/**
 * Bottom-anchored hosts (ChatView packs the flow with `justify-content:
 * flex-end`) translate every pre-overflow growth into an instant upward step
 * of the whole column — a line lands and everything on screen hops up by one
 * line-height. No scroll-domain engine can smooth that, because
 * `scrollHeight` does not move while the host slack absorbs the growth.
 *
 * Owning `min-height` on the flow removes the slack instead: the column
 * always fills the scrollport, content grows downward where it is visible,
 * and real overflow — which the spring does model — begins with the very
 * first wrapped line. The style is owned in a page-realm registry so a
 * re-injected bundle adopts it rather than fighting it.
 *
 * The fill targets the VISIBLE client box, not the raw `clientHeight`.
 * Imposing `min-height: clientHeight` inflates `scrollHeight` by whatever
 * the scroller holds beyond the flow (its own padding-bottom, adjacent
 * chrome); with short content the engine then sees a phantom floor equal to
 * that padding and scrolls the conversation up — top edge off-screen while
 * blank padding sits at the bottom. The overshoot is measured once per port
 * and subtracted, so short content reaches `scrollHeight == clientHeight`
 * and the floor is exactly zero.
 */
interface FollowFlowFill {
  readonly element: HTMLElement
  readonly original: string
  /** Scroller height held by padding/chrome above the flow, px. */
  readonly overshootPx: number
}
const FOLLOW_FLOW_FILL_SYMBOL = Symbol.for('dsh-smooth-stream.follow-flow-fill')
const followFlowFillHost = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<HTMLElement, FollowFlowFill> | undefined
}
const followFlowFills = followFlowFillHost[FOLLOW_FLOW_FILL_SYMBOL]
  ?? new WeakMap<HTMLElement, FollowFlowFill>()
followFlowFillHost[FOLLOW_FLOW_FILL_SYMBOL] = followFlowFills
const FOLLOW_FLOW_FILL_USERS_SYMBOL = Symbol.for('dsh-smooth-stream.follow-flow-fill-users')
const followFlowFillUsersHost = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<HTMLElement, number> | undefined
}
const followFlowFillUsers = followFlowFillUsersHost[FOLLOW_FLOW_FILL_USERS_SYMBOL]
  ?? new WeakMap<HTMLElement, number>()
followFlowFillUsersHost[FOLLOW_FLOW_FILL_USERS_SYMBOL] = followFlowFillUsers

function flowElementOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector<HTMLElement>('[data-chat-transcript]')
    ?? port.querySelector<HTMLElement>('[data-chat-flow]')
}

function ensureFlowFillsPort(port: HTMLElement): void {
  const element = flowElementOf(port)
  const owned = followFlowFills.get(port)
  if (element === null) {
    if (owned !== undefined) restoreFlowFill(port)
    return
  }
  const client = Math.max(0, port.clientHeight)
  let overshoot = owned?.overshootPx
  if (overshoot === undefined) {
    // Measure once per port: impose the full fill, read the scrollHeight
    // excess (scroller padding / chrome), then restore the natural state.
    const pendingOriginal = element.style.minHeight
    element.style.minHeight = `${client}px`
    overshoot = Math.max(0, port.scrollHeight - client)
    element.style.minHeight = pendingOriginal
    if (owned !== undefined) restoreFlowFill(port)
  }
  const target = `${Math.max(0, client - overshoot)}px`
  if (owned !== undefined) {
    if (owned.element === element && owned.overshootPx === overshoot && element.style.minHeight === target) return
    restoreFlowFill(port)
  }
  const original = element.style.minHeight
  element.style.minHeight = target
  followFlowFills.set(port, { element, original, overshootPx: overshoot })
}

function restoreFlowFill(port: HTMLElement): void {
  const owned = followFlowFills.get(port)
  if (owned === undefined) return
  owned.element.style.minHeight = owned.original
  followFlowFills.delete(port)
}

/** Height committed by one newly mounted Chat row, including its flex gap. */
function entranceExtentOf(root: HTMLElement): number {
  const row = root.closest<HTMLElement>('[data-chat-flow-key]') ?? root
  const rect = row.getBoundingClientRect()
  const height = Math.max(0, rect.height, rect.bottom - rect.top, row.offsetHeight)
  let previous = row.previousElementSibling
  while (previous instanceof HTMLElement) {
    const previousRect = previous.getBoundingClientRect()
    if (previousRect.height > 0 || previousRect.bottom > previousRect.top) {
      return Math.max(height, rect.bottom - previousRect.bottom)
    }
    previous = previous.previousElementSibling
  }
  return height
}

interface FollowRunway {
  readonly element: HTMLElement
  readonly offset: number
  readonly original: string
  readonly property: 'marginBottom' | 'marginTop'
  readonly requestedPx: number
  readonly normalizedLegacy?: boolean
}

/**
 * The plugin can be reinjected without replacing the conversation DOM. Keep
 * runway ownership in the page realm so a fresh bundle adopts the existing
 * margin instead of treating it as host layout and adding another 48px.
 */
const FOLLOW_RUNWAYS_SYMBOL = Symbol.for('dsh-smooth-stream.follow-runways')
const followRunwayRegistry = globalThis as typeof globalThis & {
  [key: symbol]: WeakMap<HTMLElement, FollowRunway> | undefined
}
const followRunways = followRunwayRegistry[FOLLOW_RUNWAYS_SYMBOL]
  ?? new WeakMap<HTMLElement, FollowRunway>()
followRunwayRegistry[FOLLOW_RUNWAYS_SYMBOL] = followRunways

interface FollowPaintLimit {
  readonly clientHeight: number
  readonly limit: number
  readonly measuredAtMs: number
  readonly composer: HTMLElement | null
  readonly status: HTMLElement | null
  readonly surface: HTMLElement | undefined
}

/**
 * A rect read can force a layout flush. At the floor the flow bottom sits on
 * the scrollport bottom, so while content streams the paint limit (chrome top
 * minus flow bottom) is constant; it only truly changes when the viewport or
 * conversation chrome changes. A measured limit therefore stays trusted for
 * this long even as contentHeight grows, so ordinary glyph frames never pay
 * a forced layout.
 */
export const FOLLOW_PAINT_LIMIT_TTL_MS = 250

const followPaintLimits = new WeakMap<HTMLElement, FollowPaintLimit>()
const followHadChrome = new WeakSet<HTMLElement>()
/** Last painted shift per port, to spread a wrap's one-line step over frames. */
const followLastShiftPx = new WeakMap<HTMLElement, number>()
/**
 * Screen-space completion anchor per port, SHARED by every follower arm and
 * the settle loop. Per-arm closures made the guard incoherent across the
 * completion cascade: block arms hand off leadership mid-turn, each new
 * settle loop re-seeded its own baseline at the already-jumped position, and
 * the cascade's one-frame clamp jump painted uncompensated. One baseline per
 * port also makes concurrent guards idempotent — whoever compensates first
 * restores the anchor, so the second measure reads ~0 and grants nothing.
 *
 * The anchor is the READING surface (the current turn's assistant row), not
 * the bottom-most shift surface: the cascade mounts/unmounts rows at the
 * column's bottom (process/tail mount, status swap), which switches
 * `at(-1)`'s identity mid-guard. Measuring across that switch reads a newly
 * mounted tail row as a >1000px "content moved down" push and floods the
 * pad, while the reading surface's real clamp jump goes uncompensated.
 */
interface FollowGuardAnchor {
  readonly element: HTMLElement
  /** Held viewport top — the position the reader should keep seeing. */
  readonly top: number
  /** Flow-child index, to tell an in-place replacement from a new turn. */
  readonly index: number
  /** Scroll geometry at store time, to identify an extent-neutral scroll. */
  readonly scrollTop: number
  readonly scrollHeight: number
  /**
   * Compositor shift and owned pad at store time. The engine moves the
   * rendered anchor between guard passes through TWO channels — the shift
   * glide (reveal decay: renderedΔ = −shiftΔ) and the pad retirement (the
   * floor sinks with the pad and the pin follows: renderedΔ = −padΔ). Only
   * the delta beyond BOTH is host motion worth compensating.
   */
  readonly shift: number
  readonly pad: number
}
const followGuardAnchors = new WeakMap<HTMLElement, FollowGuardAnchor>()
/**
 * Ports whose completion settle loop owns the follow. The settle drains the
 * reveal, retires the pad and guards the cascade; the swap that ends the
 * turn REMOUNTS the follower arms in the same frame cluster, and a freshly
 * mounted arm primes with a higher generation and would otherwise steal the
 * port mid-drain — its observers miss the cascade mutations (armed after
 * the fact) and its state initialization re-materializes engine space.
 * Ownership is released only when the settle finishes, the reader gestures,
 * or a genuinely NEW turn arrives (a user row joined since the handoff).
 */
const followCompletionSettle = new WeakSet<HTMLElement>()
/** User-row count at handoff, for the new-turn check above. */
const followCompletionSettleRows = new WeakMap<HTMLElement, number>()

/** User rows below the flow, or -1 when the host does not label rows with
 *  `data-chat-flow-kind` (the engine's own audit benches): the new-turn
 *  check is unsupported there and ownership guarding must stay OFF. */
function countUserRows(port: HTMLElement): number {
  const flow = flowElementOf(port)
  if (flow === null) return -1
  let count = 0
  let sawKind = false
  for (const child of flow.children) {
    if (!(child instanceof HTMLElement)) continue
    const kind = child.getAttribute('data-chat-flow-kind')
    if (kind !== null) sawKind = true
    if (kind === 'user') count++
  }
  return sawKind ? count : -1
}

/** True while this port's completion settle owns the follow and no new turn
 *  has arrived since the handoff. */
function completionSettleGuardsPort(port: HTMLElement): boolean {
  if (!followCompletionSettle.has(port)) return false
  const baseline = followCompletionSettleRows.get(port) ?? -1
  const current = countUserRows(port)
  return baseline >= 0 && current >= 0 && current <= baseline
}
/**
 * Ports whose completion settle loop owns the follow. A settle loop drains,
 * retires the pad and guards the cascade; an arm that primes while this is
 * set with `active === false` (the settled-side static arm mounting in the
 * very swap frame) must NOT seize leadership — the swap re-renders the node
 * view, a fresh arm would otherwise steal the port mid-drain with
 * `reservePx = ownedBottomSpace` (the pad!), re-materialize an equal runway
 * through applyVisual, double-count the extent and fight the settle's own
 * guard for the rest of the window. A streaming arm (active === true, the
 * next turn) still takes over normally and the settle yields.
 */

function readingAnchorOf(port: HTMLElement): HTMLElement | null {
  const flow = flowElementOf(port)
  if (flow === null) return null
  let anchor: HTMLElement | null = null
  for (const child of flow.children) {
    if (!(child instanceof HTMLElement)) continue
    if (child.getAttribute('data-chat-flow-kind') === 'assistant' || child.querySelector('[data-variant="think"]') !== null) {
      anchor = child
    }
  }
  return anchor ?? shiftSurfacesOf(port).at(-1) ?? null
}

/**
 * Measure the reading surface's screen delta since the last guard pass.
 * Returns null when there is nothing comparable yet (first observation), or
 * when the anchor changed identity in a way that is NOT the in-place
 * live→settled replacement (a new turn's row joined — nothing jumped,
 * re-seed). Compensation sites must store the POST-compensation held
 * position via `holdGuardAnchor`, or the guard would read its own
 * correction as a fresh jump and oscillate.
 */
function measureReadingAnchor(port: HTMLElement): { anchor: HTMLElement; index: number; top: number; delta: number } | null {
  const anchor = readingAnchorOf(port)
  if (anchor === null) {
    followGuardAnchors.delete(port)
    return null
  }
  const rect = anchor.getBoundingClientRect()
  // Unmeasurable geometry (jsdom's zero rects, a detached row): screen-space
  // comparison is meaningless — never seed or compensate from it.
  if (!(rect.width > 0 || rect.height > 0)) return null
  const top = rect.top
  const shift = currentShiftOf(anchor)
  const pad = flowPadOf(port)
  const scrollTop = port.scrollTop
  const scrollHeight = port.scrollHeight
  const flow = flowElementOf(port)
  const index = flow === null ? -1 : [...flow.children].indexOf(anchor)
  const stored = followGuardAnchors.get(port)
  if (stored === undefined) {
    followGuardAnchors.set(port, { element: anchor, top, index, shift, pad, scrollTop, scrollHeight })
    return null
  }
  // A host bottom-follow write is NOT a layout push. With extent unchanged, a
  // scrollTop change only moves the whole viewport; granting pad for it would
  // manufacture blank space and then require a second "retirement" motion.
  // Rebase both ledgers and let the writer keep its scroll position.
  if (
    Math.abs(scrollHeight - stored.scrollHeight) <= 0.5
    && Math.abs(scrollTop - stored.scrollTop) > 0.5
  ) {
    followScrollLedgers.set(port, scrollTop)
    followGuardAnchors.set(port, { element: anchor, top, index, shift, pad, scrollTop, scrollHeight })
    return null
  }
  // Host-caused motion only: the engine's own shift glide and floor changes
  // cancel out (renderedΔ = topΔ − shiftΔ + floorΔ).
  const delta = (top - stored.top) - (shift - stored.shift) + (pad - stored.pad)
  if (stored.element === anchor) {
    // Refresh the baseline to the current rendered position on every
    // measurement: between guard passes the viewport legitimately moves
    // (streaming pins, reveal glide), and a stale baseline would read the
    // accumulated motion as one giant host jump at the next commit.
    followGuardAnchors.set(port, { element: anchor, top, index, shift, pad, scrollTop, scrollHeight })
    return { anchor, index, top, delta }
  }
  // Identity changed. An in-place replacement (same slot, old node detached)
  // is the live→settled swap: bridge it by holding the reading surface at
  // its pre-swap viewport position. Anything else (the next turn's row
  // joining below, a session swap) is new layout — re-seed, never hold.
  if (!stored.element.isConnected && stored.index === index) {
    return { anchor, index, top, delta }
  }
  followGuardAnchors.set(port, { element: anchor, top, index, shift, pad, scrollTop, scrollHeight })
  return null
}

/** Record the position the reader should keep seeing after a correction. */
function holdGuardAnchor(
  port: HTMLElement,
  measured: { anchor: HTMLElement; index: number },
  heldTop: number,
): void {
  followGuardAnchors.set(port, {
    element: measured.anchor,
    index: measured.index,
    top: heldTop,
    shift: currentShiftOf(measured.anchor),
    pad: flowPadOf(port),
    scrollTop: port.scrollTop,
    scrollHeight: port.scrollHeight,
  })
}
/** Last runway offset seen per port, to rebase the extent when the margin size changes. */
const followRunwayOffsetHistory = new WeakMap<HTMLElement, number>()
/** Last observed scroll floor per port, for the slack→overflow runway re-measure. */
const followFloorHistory = new WeakMap<HTMLElement, number>()
/** One-shot flag: the transition frame must paint the full runway as baseline. */
const followSlackTransition = new WeakSet<HTMLElement>()

/**
 * Bottom padding a completed settle left BELOW the status row. The settle
 * retires the owned runway by moving it from the status's top margin (the
 * visible reserve gap) to the flow's bottom padding (space under the chrome):
 * scroll extent stays constant, so the floor — and therefore the pinned
 * scrollTop and every content pixel — never moves, while the status glides up
 * to meet the final line. The pad is reclaimed back into the next stream's
 * runway by `ensureRunway`, so completions never accumulate dead space.
 */
interface FollowSettlePad {
  readonly element: HTMLElement
  readonly original: string
  readonly px: number
}
const followSettlePads = new WeakMap<HTMLElement, FollowSettlePad>()

/**
 * Retired follower space lives as `padding-bottom` on the FLOW element — the
 * one node the engine already owns styles on (flow-fill min-height) and the
 * host never rewrites. Host completion commits routinely REPLACE row elements
 * (live→settled swap re-keys the assistant row, the status row unmounts), and
 * any engine space written on those rows dies with them, sinking the floor
 * and slamming the pinned transcript for a frame. The flow survives.
 */
function flowPadOf(port: HTMLElement): number {
  return followSettlePads.get(port)?.px ?? 0
}
/**
 * After a loss is re-opened as pad, a registry entry whose element is no
 * longer connected claims extent that no longer exists; drop it so the next
 * `ensureRunway` re-measures fresh instead of double-counting.
 */
function pruneDeadRunway(port: HTMLElement): boolean {
  const runway = followRunways.get(port)
  if (runway !== undefined && !runway.element.isConnected) {
    restoreRunway(port)
    return true
  }
  return false
}

function setFlowPad(port: HTMLElement, px: number): void {
  const flow = flowElementOf(port)
  if (flow === null) return
  const existing = followSettlePads.get(port)
  const original = existing?.original ?? flow.style.paddingBottom
  if (px <= FOLLOW_SETTLE_EPSILON_PX) {
    if (existing !== undefined) {
      flow.style.paddingBottom = existing.original
      followSettlePads.delete(port)
    }
    return
  }
  flow.style.paddingBottom = original === ''
    ? `${px}px`
    : `calc(${original} + ${px}px)`
  followSettlePads.set(port, { element: flow, original, px })
}

/** Extent the follower owns below the content: the live runway margin plus
 *  the retired completion pad. At adopt the pad is reclaimed into the fresh
 *  reservation (same frame, pre-paint), so the floor never steps. */
function ownedBottomSpaceOf(port: HTMLElement): number {
  return runwayOffsetOf(port) + flowPadOf(port)
}

/**
 * Completion-window diagnostics. Armed when a follower hands off to its
 * settle loop; every engine decision and every externally-written scroll
 * position inside the window prints one compact console line, so a live
 * host session can be diffed against the lab without a debugger.
 */
let followTraceUntilMs = 0
function traceActive(): boolean {
  // Completion/finalize paths arm short trace windows automatically. Keep the
  // code path in published bundles, but do not emit console noise unless the
  // user has explicitly turned on render diagnostics.
  return debugRuntime.isEnabled() && performance.now() < followTraceUntilMs
}
function followTrace(event: string, detail: Record<string, number | string | boolean>): void {
  if (!traceActive()) return
  console.log(`[dsh-follow] ${event}`, JSON.stringify(detail))
}
function hostShOf(port: HTMLElement): number {
  return port.scrollHeight
}

function invalidatePaintLimit(port: HTMLElement): void {
  followPaintLimits.delete(port)
}

interface FollowMotionState {
  readonly capacityPx: number
  readonly constrained: boolean
  readonly extent: number
  readonly lagPx: number
  readonly reservePx: number
  readonly velocityPxPerSec: number
}

/** Logical position and velocity survive a React owner handoff and finish. */
const followMotionStates = new WeakMap<HTMLElement, FollowMotionState>()

/**
 * Reader-release record that must survive an ownership handoff. A follower
 * closing at stream end (finish/drain arm swap, row lifecycle flip) destroys
 * the closure holding `following = false`, and the arm taking over would
 * otherwise read the held viewport as "at bottom" and hard-snap to the
 * floor. Presence in this map means the reader's unpin away from the floor
 * is still in effect; it is cleared when a follower re-pins at the floor.
 */
interface FollowReaderHold {
  readonly atMs: number
}
const followReaderHolds = new WeakMap<HTMLElement, FollowReaderHold>()

/**
 * Commit-time correction channel. A reveal commit that lands after this
 * frame's ResizeObserver delivery would otherwise paint one intermediate
 * frame — content grown, scrollTop/transform not yet compensated — before
 * the next tick fixes it. Reveal arms call {@link notifyFollowCommit} right
 * after their commit; the leading follower re-runs its geometry in the same
 * task, so the intermediate state never reaches a paint.
 */
const followCommitListeners = new WeakMap<HTMLElement, Set<() => void>>()

export function notifyFollowCommit(fromInsidePort: HTMLElement | null): void {
  if (fromInsidePort === null) return
  const port = fromInsidePort.closest<HTMLElement>('[data-conversation-scroll]')
  const listeners = port === null ? undefined : followCommitListeners.get(port)
  if (listeners === undefined) return
  for (const listener of [...listeners]) listener()
}

function subscribeFollowCommit(port: HTMLElement, fn: () => void): () => void {
  let listeners = followCommitListeners.get(port)
  if (listeners === undefined) {
    listeners = new Set()
    followCommitListeners.set(port, listeners)
  }
  listeners.add(fn)
  return () => { listeners!.delete(fn) }
}

function restoreRunway(port: HTMLElement): void {
  const runway = followRunways.get(port)
  if (runway === undefined) return
  runway.element.style[runway.property] = runway.original
  followRunways.delete(port)
  invalidatePaintLimit(port)
}

function isLegacyRunway(value: string): boolean {
  if (value === '') return false
  const terms = [...value.matchAll(/([\d.]+)px/g)]
  if (terms.length === 0 || value.replaceAll(/calc|px|[\d.+()\s]/g, '') !== '') return false
  const values = terms.map(([, raw]) => Number(raw))
  if (values.some(px => !Number.isFinite(px))) return false
  return [LEGACY_RUNWAY_PX, FOLLOW_STATUS_RUNWAY_PX].some(unit => values.every(px => (
    px >= unit && Math.abs(px % unit) <= Number.EPSILON
  )))
}

/** Remove unowned runway residue written by v0.3.3 and earlier bundles. */
function migrateLegacyRunway(
  port: HTMLElement,
  surfaces: readonly HTMLElement[],
  status: HTMLElement | null,
  composer: HTMLElement | null,
): boolean {
  if (followRunways.has(port)) return false
  let migrated = false
  if (status !== null && isLegacyRunway(status.style.marginTop)) {
    // Harness TurnStatus has no inline margin; exact 48px multiples here are
    // values emitted by the old runway writer, including reload accumulation.
    status.style.marginTop = ''
    migrated = true
  }
  const last = surfaces.at(-1)
  if (
    status === null
    && composer !== null
    && last !== undefined
    && isLegacyRunway(last.style.marginBottom)
  ) {
    // Without TurnStatus the old writer used the current final message as its
    // completion runway. Limit migration to that same target topology.
    last.style.marginBottom = ''
    migrated = true
  }
  if (migrated) invalidatePaintLimit(port)
  return migrated
}

function ensureRunway(
  port: HTMLElement,
  surfaces: readonly HTMLElement[],
  runwayPx = FOLLOW_STATUS_RUNWAY_PX,
): void {
  const status = turnStatusOf(port)
  const composer = port.querySelector<HTMLElement>('[data-composer-seat]')
  // Adopt one exact current runway before migration. Larger exact multiples
  // are accumulated residue from older bundles and must be stripped.
  if (status !== null && followRunways.get(port) === undefined) {
    const inlinePx = Number.parseFloat(status.style.marginTop ?? '') || 0
    if (Math.abs(inlinePx - FOLLOW_STATUS_RUNWAY_PX) <= 0.5) {
      followRunways.set(port, {
        element: status,
        offset: inlinePx,
        property: 'marginTop',
        original: '',
        requestedPx: inlinePx,
      })
      invalidatePaintLimit(port)
    }
  }
  const migratedLegacy = migrateLegacyRunway(port, surfaces, status, composer)
  // A runway is useful only after the natural conversation already has a
  // scroll floor for its equal message transform to ride. Before that point
  // applyVisual keeps every surface in normal flow, so adding status margin
  // would expose the whole runway as empty space below a short/early Think.
  const naturalHeight = Math.max(0, port.scrollHeight - runwayOffsetOf(port))
  const existing = followRunways.get(port)
  const requestedRunwayPx = migratedLegacy || existing?.normalizedLegacy === true
    ? FOLLOW_STATUS_RUNWAY_PX
    : runwayPx
  if (requestedRunwayPx <= 0 || port.clientHeight <= 0 || naturalHeight <= port.clientHeight) {
    restoreRunway(port)
    return
  }
  const target = status === null
    ? { element: composer === null ? undefined : surfaces.at(-1), property: 'marginBottom' as const }
    : { element: status, property: 'marginTop' as const }
  if (target.element === undefined) {
    restoreRunway(port)
    return
  }
  const element = target.element
  const current = followRunways.get(port)
  if (current?.element === element
    && current.property === target.property
    && current.requestedPx === requestedRunwayPx) return

  restoreRunway(port)
  const beforeHeight = port.scrollHeight
  const original = element.style[target.property]
  element.style[target.property] = original === ''
    ? `${requestedRunwayPx}px`
    : `calc(${original} + ${requestedRunwayPx}px)`
  const offset = Math.max(0, port.scrollHeight - beforeHeight)
  followRunways.set(port, {
    element,
    offset,
    property: target.property,
    original,
    requestedPx: requestedRunwayPx,
    normalizedLegacy: migratedLegacy || existing?.normalizedLegacy === true,
  })
  invalidatePaintLimit(port)
}

function runwayOffsetOf(port: HTMLElement): number {
  return followRunways.get(port)?.offset ?? 0
}

/**
 * Move owned runway margin into the persistent flow pad without changing the
 * scroll extent. Returns the actual layout pixels removed from the margin.
 */
function transferRunwayToFlowPad(port: HTMLElement, requestedPx: number): number {
  const runway = followRunways.get(port)
  if (runway === undefined || requestedPx <= 0 || !runway.element.isConnected) return 0
  const nextRequestedPx = Math.max(0, runway.requestedPx - requestedPx)
  const beforeOffset = runway.offset
  const beforeHeight = port.scrollHeight
  runway.element.style[runway.property] = nextRequestedPx <= FOLLOW_SETTLE_EPSILON_PX
    ? runway.original
    : runway.original === ''
      ? `${nextRequestedPx}px`
      : `calc(${runway.original} + ${nextRequestedPx}px)`
  const nextOffset = Math.max(0, beforeOffset + port.scrollHeight - beforeHeight)
  const transferredPx = Math.max(0, beforeOffset - nextOffset)
  if (nextRequestedPx <= FOLLOW_SETTLE_EPSILON_PX || nextOffset <= FOLLOW_SETTLE_EPSILON_PX) {
    followRunways.delete(port)
  } else {
    followRunways.set(port, {
      ...runway,
      offset: nextOffset,
      requestedPx: nextRequestedPx,
    })
  }
  if (transferredPx > 0) {
    setFlowPad(port, flowPadOf(port) + transferredPx)
    invalidatePaintLimit(port)
  }
  return transferredPx
}

/** Available paint room below the last message before fixed conversation chrome. */
function safeShiftLimit(
  port: HTMLElement,
  surfaces: readonly HTMLElement[],
): number {
  const last = surfaces.at(-1)
  if (last === undefined) return 0
  const status = turnStatusOf(port)
  const composer = port.querySelector<HTMLElement>('[data-composer-seat]')
  if (status !== null || composer !== null) followHadChrome.add(port)
  const cached = followPaintLimits.get(port)
  // Content growth alone cannot move the limit (measured at the floor, the
  // flow bottom rides the scrollport bottom), so the cache survives glyph
  // frames and only chrome/viewport changes or the TTL force a re-measure.
  if (
    cached !== undefined
    && performance.now() - cached.measuredAtMs <= FOLLOW_PAINT_LIMIT_TTL_MS
    && cached.clientHeight === port.clientHeight
    && cached.surface === last
    && cached.status === status
    && cached.composer === composer
  ) return cached.limit
  const ceiling = [status, composer]
    .filter((element): element is HTMLElement => element !== null)
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    // A detached or still-unmeasured sticky seat returns an all-zero rect.
    // It cannot constrain paint yet; a real seat at viewport top remains
    // valid because its bottom is still below its top.
    .filter(({ rect }) => Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top)
    .sort((first, second) => first.rect.top - second.rect.top)[0]
  if (ceiling === undefined) {
    // No conversation chrome means there is nothing to overlap. If chrome is
    // mounted but has not measured yet, permit only the runway zero-point
    // until ResizeObserver provides a real ceiling.
    return status === null && composer === null
      ? followHadChrome.has(port) ? 0 : Number.POSITIVE_INFINITY
      : runwayOffsetOf(port)
  }
  const ceilingTop = ceiling.rect.top - currentShiftOf(ceiling.element)
  const naturalBottom = last.getBoundingClientRect().bottom - currentShiftOf(last)
  const limit = Math.max(0, ceilingTop - naturalBottom - FOLLOW_PAINT_GUARD_PX)
  followPaintLimits.set(port, {
    clientHeight: port.clientHeight,
    limit,
    measuredAtMs: performance.now(),
    composer,
    status,
    surface: last,
  })
  return limit
}

function setFollowScrollTop(port: HTMLElement, nextTop: number): void {
  const ledger = followScrollLedgers.get(port)
  // Claim before the write so a Host ResizeObserver that runs in the same task
  // sees the owner instead of racing in with its own bottom-follow.
  if (port.getAttribute(FOLLOW_OWNED_ATTR) === null) {
    port.setAttribute(FOLLOW_OWNED_ATTR, 'active')
  }
  // Someone else wrote scrollTop since our last write (host floor-snap,
  // browser clamp, reader): surface it — a fight between the host's own
  // follow controller and this engine is the completion-jitter suspect.
  if (ledger !== undefined && traceActive() && Math.abs(port.scrollTop - ledger) > 1) {
    followTrace('external-scroll', { from: Math.round(port.scrollTop), to: Math.round(nextTop), ledger: Math.round(ledger) })
  }
  if (Math.abs(port.scrollTop - nextTop) > 0.01) port.scrollTop = nextTop
  followScrollLedgers.set(port, port.scrollTop)
  const ownedTop = String(port.scrollTop)
  if (port.getAttribute(FOLLOW_OWNED_ATTR) !== ownedTop) {
    port.setAttribute(FOLLOW_OWNED_ATTR, ownedTop)
  }
}

/**
 * Last scrollTop this engine wrote or accepted, per port. Reader intent is a
 * real upward delta from this ledger; a key press or touch while pinned
 * (typing in the composer) must not release the pin, because a released pin
 * can never re-acquire while content streams away from the reader position.
 */
const followScrollLedgers = new WeakMap<HTMLElement, number>()
const followActivityAt = new WeakMap<HTMLElement, number>()
interface FollowScrollOwnership {
  /** User-row count at handoff; a larger count means a genuinely new turn. */
  readonly userRows: number
}
/**
 * Scroll ownership must survive follower-arm remounts. Per-closure state let a
 * new text/tool arm reset the strike counter, so the same host write kept
 * triggering another engine write and repainting the visible up/down fight.
 */
const followHostScrollPorts = new WeakMap<HTMLElement, FollowScrollOwnership>()

/** Clear host ownership only when a new user turn actually starts. */
function resetHostScrollOwnershipForNewTurn(port: HTMLElement): void {
  const ownership = followHostScrollPorts.get(port)
  if (ownership === undefined) return
  const userRows = countUserRows(port)
  if (userRows >= 0 && userRows > ownership.userRows) followHostScrollPorts.delete(port)
}

/** Whether this port was owned recently enough to identify a closing tail row. */
export function hasRecentConversationFollow(port: HTMLElement, windowMs = 250): boolean {
  const last = followActivityAt.get(port)
  return last !== undefined && performance.now() - last <= windowMs
}

function readerScrolledUp(port: HTMLElement): boolean {
  return port.scrollTop < (followScrollLedgers.get(port) ?? 0) - FOLLOW_UNPIN_GESTURE_PX
}

/**
 * Paint a bounded visual lag and return the effective logical extent.
 *
 * This is the final geometry invariant, not merely an animation preference:
 * any lag beyond the real gap to status/composer chrome is caught up in the
 * same frame. Carrying that excess in `scrollTop` would move the transcript
 * toward fixed chrome and also make the host expose jump-to-bottom.
 */
function applyVisual(
  port: HTMLElement,
  animatedH: number,
  reservePx: number,
  velocityPxPerSec = 0,
  runwayPx = FOLLOW_STATUS_RUNWAY_PX,
  shiftCeilingPx = Number.POSITIVE_INFINITY,
  promoteAtRest = false,
  trajectoryShiftPx?: number,
  dtMs = 16.7,
  writeScrollTop = true,
): number {
  const surfaces = shiftSurfacesOf(port)
  ensureFlowFillsPort(port)
  void runwayPx
  // A runway added while the column still fit the viewport was absorbed by
  // the host's bottom slack: its measured offset was zero, but once real
  // overflow begins the same margin costs scroll length. Detect that
  // transition BEFORE any geometry is read and re-add the margin so its
  // stored offset is measured against the true post-overflow layout.
  {
    const preFloor = Math.max(0, port.scrollHeight - port.clientHeight)
    const lastFloorSeen = followFloorHistory.get(port)
    if (lastFloorSeen !== undefined && lastFloorSeen === 0 && preFloor > 0 && followRunways.has(port)) {
      const owned = followRunways.get(port)
      restoreRunway(port)
      ensureRunway(port, surfaces, owned?.requestedPx ?? runwayPx)
      // This frame the margin materializes into scroll length AND lands in
      // the floor in the same write; painting the held reserve as baseline
      // would leave its px uncompensated on screen. Spend the full runway
      // as baseline for exactly this frame.
      followSlackTransition.add(port)
    }
    if (preFloor !== lastFloorSeen) {
      followFloorHistory.set(port, preFloor)
    }
  }
  ensureRunway(port, surfaces, reservePx)
  const contentHeight2 = Math.max(0, port.scrollHeight)
  const runwayOffset2 = runwayOffsetOf(port)
  // Rebase the spring extent onto the current offset domain. targetHeight
  // = contentHeight − offset AND animatedH live in the same space; when the
  // margin grows, targetHeight drops by the offset's growth, so animatedH
  // must drop in lockstep or the whole req (painted shift) is released as
  // an upward snap. Shifting both by the same delta leaves the painted
  // shift untouched.
  const prevOffset2 = followRunwayOffsetHistory.get(port)
  if (prevOffset2 !== undefined && runwayOffset2 !== prevOffset2) {
    animatedH = Math.max(0, animatedH - (runwayOffset2 - prevOffset2))
  }
  followRunwayOffsetHistory.set(port, runwayOffset2)
  const contentHeight = contentHeight2
  const runwayOffset = runwayOffset2
  const targetHeight = Math.max(0, contentHeight - runwayOffset)
  const floor = Math.max(0, contentHeight - port.clientHeight)
  const extent = Math.min(targetHeight, Math.max(0, animatedH))
  if (port.style.overflowAnchor !== 'none') port.style.overflowAnchor = 'none'
  if (port.style.scrollBehavior !== 'auto') port.style.scrollBehavior = 'auto'
  if (floor <= 0) {
    followRunwayOffsetHistory.set(port, 0)
    if (writeScrollTop) setFollowScrollTop(port, 0)
    followMotionStates.set(port, {
      capacityPx: Number.POSITIVE_INFINITY,
      constrained: false,
      extent: targetHeight,
      lagPx: 0,
      reservePx: 0,
      velocityPxPerSec: 0,
    })
    for (const surface of surfaces) setShift(surface, 0)
    followLastShiftPx.set(port, 0)
    const status = turnStatusOf(port)
    if (status !== null) setShift(status, 0)
    return targetHeight
  }
  // The visible scroll position rides the spring's smooth extent so each newly
  // revealed line is approached at continuous velocity instead of snapping the
  // whole wrap into one frame (the residual "不丝滑" jump). `animatedH` advances
  // by the spring's bounded per-frame step; the newest ≤ `visibleReserve` lines
  // stay hidden below the fold in the runway while `scrollTop` glides up to
  // reveal them. Concretely: `scrollTop = floor − min(requestedLag, reserve)`,
  // so during fast typing scrollTop trails floor by at most one runway (≤ 2
  // lines) advancing smoothly at the spring cadence; when typing stops and lag
  // exhausts, scrollTop converges to the floor. The shift below still holds the
  // reserve so no per-wrap tail jump appears.
  const limit = safeShiftLimit(port, surfaces)
  followSlackTransition.delete(port)
  const visibleReserve = Math.min(runwayOffset, Math.max(0, reservePx))
  const baselineShift = runwayOffset - visibleReserve
  const requestedLag = Math.max(0, targetHeight - extent)
  // Steady-state tail pin: while the predictive reserve is held, paint the
  // shifted surfaces at a FIXED offset equal to the reserve, so the newest
  // revealed line rides at a constant viewport position and every wrap's reveal
  // lands below the fold inside that space — instead of translating the whole
  // message by the decaying per-reveal lag (which moved the newest line up/down
  // at reveal cadence = the residual "轻微回弹来回" jitter). The reserve is held
  // constant during streaming; only when it retires (entrance/settle) does the
  // shift glide with it. The spring still closes below the fold, and backpressure
  // reads the untranslated requestedLag so reveal pacing is unchanged.
  const availableShift = Math.min(
    Math.max(0, limit),
    Math.max(0, shiftCeilingPx),
  )
  const motionShift = Math.min(
    trajectoryShiftPx ?? baselineShift + requestedLag,
    availableShift,
  )
  const idlePromotion = promoteAtRest && motionShift <= 0.01 && availableShift > 0 ? 0.1 : 0
  let shift = Math.max(motionShift, idlePromotion)
  const previousShift = followLastShiftPx.get(port)
  const maxDecayPx = dtMs <= 0
    ? FOLLOW_PAINT_SHIFT_MAX_STEP_PX
    : Math.max(1, (FOLLOW_PAINT_SHIFT_MAX_STEP_PX / 16.67) * dtMs)
  if (previousShift !== undefined && shift < previousShift - maxDecayPx) {
    // Decay-only rate limit. Growth is a WRAP COMPENSATION: the floor already
    // jumped one line in the same layout pass and `scrollTop` followed it, so
    // the matching shift increase cancels that step exactly. Rate-limiting it
    // paints the uncovered remainder as a visible one-frame jump (the
    // "换行 18px 跳变"). Only the decay side — runway retirement and settle —
    // is a real animation and keeps its per-frame bound.
    shift = previousShift - maxDecayPx
  }

  followLastShiftPx.set(port, shift)
  const requestedShift = trajectoryShiftPx ?? (baselineShift + requestedLag)
  const effectiveLag = Math.max(0, shift - baselineShift)
  const capacityPx = Math.max(0, limit - baselineShift)
  const effectiveExtent = targetHeight - effectiveLag
  const isConstrained = requestedShift > availableShift + FOLLOW_SETTLE_EPSILON_PX
    || (limit <= 0 && requestedShift > baselineShift)
  if (writeScrollTop) setFollowScrollTop(port, floor)
  followMotionStates.set(port, {
    capacityPx,
    constrained: isConstrained,
    extent: effectiveExtent,
    lagPx: effectiveLag,
    reservePx: visibleReserve,
    velocityPxPerSec,
  })
  for (const surface of surfaces) setShift(surface, shift)
  const status = turnStatusOf(port)
  if (status !== null) setShift(status, 0)
  return effectiveExtent
}

function clearMotion(port: HTMLElement): void {
  port.removeAttribute(FOLLOW_OWNED_ATTR)
  port.style.overflowAnchor = ''
  port.style.scrollBehavior = ''
  for (const surface of shiftSurfacesOf(port)) setShift(surface, 0)
  const status = turnStatusOf(port)
  if (status !== null) setShift(status, 0)
}

function clearVisual(port: HTMLElement): void {
  clearMotion(port)
  restoreRunway(port)
  followMotionStates.delete(port)
  followLastShiftPx.delete(port)
  invalidatePaintLimit(port)
}

/** Keep an already-promoted surface at zero until one stable final paint lands. */
function holdCompositorAtRest(element: HTMLElement): void {
  element.style.transform = 'translate3d(0, 0px, 0)'
  element.style.willChange = 'transform'
  element.style.clipPath = ''
}

/** Remove equal offsets, land on the floor, then retire the compositor quietly. */
function finishAtNaturalFloor(
  port: HTMLElement,
  retainCompositor = true,
  writeScrollTop = true,
): void {
  followCompletionSettle.delete(port)
  followTraceUntilMs = Math.max(followTraceUntilMs, performance.now() + 10000)
  followTrace('finish-enter', { sh: hostShOf(port), st: Math.round(port.scrollTop), pad: Math.round(flowPadOf(port)), retain: retainCompositor })
  const surfaces = shiftSurfacesOf(port)
  const status = turnStatusOf(port)
  if (!retainCompositor) {
    restoreRunway(port)
    if (writeScrollTop) settleAtFloor(port)
    clearMotion(port)
    followMotionStates.delete(port)
    return
  }
  const promoted = [...surfaces, ...(status === null ? [] : [status])]
    .filter(element => element.style.transform !== '' || element.style.willChange === 'transform')
  const promotedSet = new Set(promoted)
  if (writeScrollTop) settleAtFloor(port)
  port.removeAttribute(FOLLOW_OWNED_ATTR)
  port.style.overflowAnchor = ''
  port.style.scrollBehavior = ''
  for (const surface of surfaces) {
    if (promotedSet.has(surface)) holdCompositorAtRest(surface)
    else setShift(surface, 0)
  }
  if (status !== null) {
    if (promotedSet.has(status)) holdCompositorAtRest(status)
    else setShift(status, 0)
  }
  followMotionStates.delete(port)
  if (promoted.length === 0) return
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const element of promoted) {
        if (Math.abs(currentShiftOf(element)) <= 0.01) setShift(element, 0)
      }
    })
  })
}

function settleAtFloor(port: HTMLElement): void {
  const floor = Math.max(0, port.scrollHeight - port.clientHeight)
  setFollowScrollTop(port, floor)
  followReaderHolds.delete(port)
}

interface FollowLeader {
  readonly generation: number
  readonly owner: object
}

/** Only the newest active follower may write one port's shared visual state. */
const followLeaders = new WeakMap<HTMLElement, FollowLeader>()
let followGeneration = 0
/** Ports with a live streaming arm; completion guards must not fight them. */
const followActivePorts = new WeakSet<HTMLElement>()

/**
 * Own the conversation scrollport's bottom-follow while `active` is true.
 *
 * @param rootRef - An element inside the conversation scrollport.
 * @param active - True while the reply is still revealing.
 * @param speedCpsRef - Live reveal-rate EMA from the smoother.
 * @param revealScaleRef - Optional backpressure control for text reveal.
 * @param predictive - Whether to reserve paint room ahead of growth.
 * @param entrance - Whether the first committed row height should glide in.
 * @param onEntranceSettled - Releases a one-shot entrance owner after catch-up.
 * @param predictiveRef - Optional live visibility gate for predictive runway.
 * @param entranceExtentRef - Optional measured growth delta for a generic row.
 * @param revealedCharsRef - Committed code-point count for feed-forward phase.
 * @param controlScroll - When false, leave the scrollport entirely to the Host.
 */
export function useConversationFollow(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  speedCpsRef: { current: number },
  revealScaleRef?: { current: number },
  predictive = true,
  entrance = false,
  onEntranceSettled?: () => void,
  predictiveRef?: { current: boolean },
  entranceExtentRef?: { current: number | null },
  revealedCharsRef?: { current: number },
  controlScroll = true,
): void {
  const activeRef = useRef(active)
  const entranceRef = useRef(entrance)
  const onEntranceSettledRef = useRef(onEntranceSettled)
  entranceRef.current = entrance
  onEntranceSettledRef.current = onEntranceSettled
  activeRef.current = active
  const controlScrollRef = useRef(controlScroll)
  controlScrollRef.current = controlScroll

  useLayoutEffect(() => {
    if (!controlScroll) return
    if (!active) return
    const startedAsEntrance = entrance
    const owner = {}
    const generation = ++followGeneration
    let rafId = 0
    let last = performance.now()
    let following = true
    let primed = false
    let animatedH = 0
    let reservePx = 0
    let velocityPxPerSec = 0
    let interacting = false
    let readerGestureIntent = false
    let readerReleased = false
    let touchStartY: number | null = null
    let interactTimer: ReturnType<typeof setTimeout> | null = null
    let port: HTMLElement | null = null
    let resize: ResizeObserver | null = null
    let mutations: MutationObserver | null = null
    let observedTail: HTMLElement | null = null
    let statusWasPresent: boolean | null = null
    let lastStatusHeightPx = 0
    let trajectoryPositionPx: number | null = null
    let trajectoryVelocityPxPerMs = 0
    let trajectoryTargetVelocityPxPerMs = 0
    let trajectoryFloorPx: number | null = null
    let trajectoryGrowthAtMs: number | null = null
    let trajectoryAccumulatedGrowthPx = 0
    let trajectoryAccumulatedGrowthMs = 0
    let trajectoryGrowthSamples = 0
    let trajectoryWasActive = false
    const revealPhase = new FollowRevealPhaseTracker()
    let holding: HTMLElement | null = null
    let entrancePending = entranceRef.current

    const finishEntrance = (): void => {
      if (!entrancePending) return
      entrancePending = false
      onEntranceSettledRef.current?.()
    }

    const updateRevealScale = (next: HTMLElement, elapsedMs: number, urgent = false): void => {
      if (revealScaleRef === undefined) return
      const tuning = debugRuntime.activeTuning()
      const state = followMotionStates.get(next)
      const target = state === undefined
        ? 1
        : computeFollowRevealScale(state.lagPx, state.capacityPx, state.constrained, tuning)
      const current = Math.min(1, Math.max(tuning.backpressureMinScale, revealScaleRef.current))
      if (target < current || urgent) {
        // Slowing affects only future glyph commits, so it can react at once
        // without producing a visual discontinuity in the current frame.
        revealScaleRef.current = Math.min(current, target)
        return
      }
      const releaseStep = 1 - Math.exp(-Math.max(0, elapsedMs) / FOLLOW_BACKPRESSURE_RELEASE_MS)
      revealScaleRef.current = current + (target - current) * releaseStep
    }

    const releaseRevealScale = (): void => {
      if (revealScaleRef !== undefined) revealScaleRef.current = 1
    }

    const reportFollow = (next: HTMLElement, isActive: boolean): void => {
      const state = followMotionStates.get(next)
      debugRuntime.reportFollow(next, {
        // TEMP audit provenance: lagPx=-1 marks the fallback path (no motion
        // state owned by this reporter this frame).
        lagPx: state ? state.lagPx : -1,
        velocityPxPerSec: state?.velocityPxPerSec ?? 0,
        reservePx: state?.reservePx ?? 0,
        capacityPx: state ? state.capacityPx : -1,
        revealScale: revealScaleRef?.current ?? 1,
        following,
        constrained: state?.constrained ?? false,
        scrollTop: next.scrollTop,
        scrollHeight: next.scrollHeight,
        clientHeight: next.clientHeight,
        active: isActive,
      })
    }

    const isLeader = (next: HTMLElement): boolean => followLeaders.get(next)?.owner === owner

    const hold = (next: HTMLElement): void => {
      followActivityAt.set(next, performance.now())
      if (holding === next && isLeader(next)) return
      holding = next
      const leader = followLeaders.get(next)
      if ((leader === undefined || generation > leader.generation) && !completionSettleGuardsPort(next)) {
        followCompletionSettle.delete(next)
        followLeaders.set(next, { generation, owner })
      }
    }

    const yieldScrollOwnership = (next: HTMLElement, floor: number): void => {
      if (hostOwnsScroll) return
      hostOwnsScroll = true
      followHostScrollPorts.set(next, { userRows: countUserRows(next) })
      followTrace('yield-scroll', {
        from: Math.round(next.scrollTop),
        to: Math.round(floor),
      })
      // A host-owned port must be a clean host-owned render. Keeping the
      // engine's transform/reserve alive lets its decay fight the host's hard
      // bottom-follow; that is the visible up/down jitter after handoff.
      clearVisual(next)
      const naturalFloor = Math.max(0, next.scrollHeight - next.clientHeight)
      setFollowScrollTop(next, naturalFloor)
      next.removeAttribute(FOLLOW_OWNED_ATTR)
      followLeaders.delete(next)
      releaseRevealScale()
      debugRuntime.reportFollow(next, null)
    }

    const detectHostScroll = (next: HTMLElement, floor: number): void => {
      if (followHostScrollPorts.has(next)) {
        hostOwnsScroll = true
        return
      }
      const ledger = followScrollLedgers.get(next)
      if (ledger === undefined || Math.abs(next.scrollTop - ledger) <= 1) return
      // A write that lands on the current floor has the same semantics as our
      // own bottom-follow (including a manual jump-to-bottom or a shrink
      // clamp). Rebase and keep smoothing; treating it as a second writer
      // would permanently retire the effect for the rest of the turn.
      if (Math.abs(next.scrollTop - floor) <= 1) {
        followScrollLedgers.set(next, next.scrollTop)
        externalScrollStrikes = 0
        return
      }
      externalScrollStrikes += 1
      if (externalScrollStrikes >= 2) yieldScrollOwnership(next, floor)
    }

    const drop = (next: HTMLElement): void => {
      if (holding === next) holding = null
      if (isLeader(next)) {
        clearMotion(next)
        followMotionStates.delete(next)
        releaseRevealScale()
        debugRuntime.reportFollow(next, null)
      }
    }

    const handBackVisual = (next: HTMLElement): void => {
      const shift = currentShiftOf(shiftSurfacesOf(next).at(-1) ?? next)
      const transferableShift = shift > FOLLOW_SETTLE_EPSILON_PX ? shift : 0
      const visualTop = Math.max(0, next.scrollTop - transferableShift)
      // The predictive runway only has meaning while this follower owns the
      // floor. Remove it before choosing the reader's landing point; keeping
      // it through the release paints a transient natural gap + 48px blank
      // block until the next follow frame restores an equal transform.
      clearMotion(next)
      restoreRunway(next)
      const floor = Math.max(0, next.scrollHeight - next.clientHeight)
      // The host keeps its own bottom-follow bit while the reader remains in
      // its 25px slack band. Land one pixel beyond that band so even a light
      // wheel/trackpad/touch intent releases both owners on the same frame.
      next.scrollTop = Math.min(visualTop, Math.max(0, floor - FOLLOW_HOST_RELEASE_PX))
      followScrollLedgers.set(next, next.scrollTop)
    }

    const markGesture = (event: Event): void => {
      interacting = true
      if (event.type === 'wheel') {
        const deltaY = (event as WheelEvent).deltaY
        if (Number.isFinite(deltaY) && deltaY < 0) readerGestureIntent = true
      } else if (event.type === 'touchstart') {
        const touch = (event as TouchEvent).touches[0]
        touchStartY = touch?.clientY ?? null
      } else if (event.type === 'touchmove') {
        const touch = (event as TouchEvent).touches[0]
        if (touch !== undefined) {
          if (touchStartY === null) touchStartY = touch.clientY
          // A downward finger drag moves the transcript toward older content.
          if (touch.clientY - touchStartY > 1) readerGestureIntent = true
        }
      } else if (event.type === 'touchend' || event.type === 'touchcancel') {
        touchStartY = null
      }
      if (interactTimer !== null) clearTimeout(interactTimer)
      interactTimer = setTimeout(() => {
        interacting = false
        readerGestureIntent = false
        interactTimer = null
      }, FOLLOW_GESTURE_MS)
    }

    /**
     * Last observed scroll extent, shared by the pre-paint correction and the
     * settle loop so a host layout shrink is re-opened exactly once no matter
     * which observer sees it first. `-1` until the first owned observation.
     */
    let settleRetiring = false
    // The engine may lead streaming writes, but the host also owns a
    // bottom-follow controller. Ledger disagreement is harmless once; a
    // repeated disagreement is proof of a second writer. Hand the scrollport
    // to that writer immediately: the engine keeps compositor compensation but
    // never writes scrollTop again. This is the only way to avoid a ping-pong
    // fight when the host bundle does not consume `data-follow-owned`.
    let hostOwnsScroll = false
    let externalScrollStrikes = 0
    let lastReadingAnchorPullAtMs = Number.NEGATIVE_INFINITY
    let readingAnchorPullBudgetPx = 0
    // Set once this closure's completion handoff has armed its settle loop.
    // Only a handed-off arm's observers may guard a LEADERLESS port: mid-turn
    // arms that never handed off must keep standing down (entrance/steaming
    // successors own the port), while a handed-off arm whose settle loop was
    // killed by leadership churn is the only pre-paint guard left when the
    // completion cascade lands in the leaderless window.
    let handedOff = false
    /**
     * Bring the reading surface back down toward its held position after an
     * upward host push (clamp jump, live→settled swap): spend persistent pad
     * first — lowering the floor lets the pin carry the text back down —
     * then raise the compositor shift for whatever pad cannot cover, and
     * rebase the spring extent so the raise survives the next applyVisual
     * (which otherwise recomputes the shift from lag and undoes it).
     */
    const pullReadingAnchorBack = (
      host: HTMLElement,
      measured: { anchor: HTMLElement; index: number; top: number; delta: number },
      trace = false,
    ): void => {
      // Experimental no-rebound gate: an upward correction here has repeatedly
      // over/under-compensated against the settle loop's floor writes. Hold the
      // new position instead of issuing a reverse correction; the monotone
      // final retirement remains the only release path.
      holdGuardAnchor(host, measured, measured.top)
      return
      const need = -measured.delta
      // A large host shrink must not spend its whole pad in one paint. Keep
      // the screen anchored with an immediate shift, then hand the floor back
      // at the same bounded rate as the final retirement.
      const now = performance.now()
      const elapsedPx = lastReadingAnchorPullAtMs === Number.NEGATIVE_INFINITY
        ? FOLLOW_PAINT_SHIFT_MAX_STEP_PX
        : Math.min(24, Math.max(0, now - lastReadingAnchorPullAtMs) * (FOLLOW_PAINT_SHIFT_MAX_STEP_PX / 16.7))
      readingAnchorPullBudgetPx = Math.min(need, readingAnchorPullBudgetPx + elapsedPx)
      lastReadingAnchorPullAtMs = now
      const released = Math.min(flowPadOf(host), readingAnchorPullBudgetPx)
      readingAnchorPullBudgetPx -= released
      if (released > FOLLOW_SETTLE_EPSILON_PX) {
        if (trace) {
          followTrace('anchor-pull', { screenDelta: Math.round(measured.delta), released: Math.round(released), st: Math.round(host.scrollTop) })
        }
        setFlowPad(host, flowPadOf(host) - released)
        animatedH = Math.max(0, animatedH - released)
      }
      const remainder = need - released
      let raise = 0
      if (remainder > 0.5) {
        const surfaces = shiftSurfacesOf(host)
        const limit = safeShiftLimit(host, surfaces)
        const current = currentShiftOf(surfaces.at(-1) ?? host)
        const target = Math.min(current + remainder, Math.max(0, limit - FOLLOW_PAINT_GUARD_PX))
        raise = target - current
        if (raise > 0) {
          for (const surface of surfaces) setShift(surface, current + raise)
          followLastShiftPx.set(host, current + raise)
          animatedH = Math.max(0, animatedH - raise)
        }
      }
      holdGuardAnchor(host, measured, measured.top + released + raise)
    }
    /**
     * THE screen-space anchor hold, shared by every entry point: the
     * structural-observer path (pre-paint cascade correction), the settle
     * loop's per-frame poll, and the ACTIVE loop's per-frame poll. The
     * shift-excluded delta filters the engine's own motion (reveal glide,
     * wrap lockstep) to ~0, so a live poll may compensate safely — which is
     * what saves the completion swap: the settled-side arm primes in its
     * layout effect and steals leadership IN the cascade frame, its own
     * observers miss the mutations (armed after the fact), and only this
     * poll sees the jump while it can still be corrected before paint.
     * Returns the measured delta (null when nothing was comparable).
     */
    const enforceReadingAnchor = (host: HTMLElement, trace = false): number | null => {
      const measured = measureReadingAnchor(host)
      if (measured === null) return null
      if (measured.delta > 0.5) {
        if (trace) {
          followTrace('anchor-hold', { screenDelta: Math.round(measured.delta), st: Math.round(host.scrollTop) })
        }
        if (pruneDeadRunway(host)) reservePx = 0
        holdGuardAnchor(host, measured, measured.top)
      } else if (measured.delta < -0.5) {
        if (pruneDeadRunway(host)) reservePx = 0
        pullReadingAnchorBack(host, measured, trace)
      } else {
        holdGuardAnchor(host, measured, measured.top)
      }
      return measured.delta
    }
    /** Pre-paint correction (observers, commit subscription). */
    const restoreBeforePaint = (): void => {
      if (!following || port === null) return
      if (hostOwnsScroll || followHostScrollPorts.has(port)) {
        hostOwnsScroll = true
        followScrollLedgers.set(port, port.scrollTop)
        return
      }
      if (!activeRef.current) {
        detectHostScroll(port, Math.max(0, port.scrollHeight - port.clientHeight))
      }
      // Yield only to a LIVE owner. Block arms hand off leadership mid-turn
      // and each handoff kills the previous settle loop; the completion
      // cascade routinely lands in the leaderless window between that death
      // and the successor's first frame. Standing down whenever leadership is
      // merely absent left the cascade's clamp jump uncompensated. While
      // SOMEONE holds the port, the dead observers must not fight the live
      // guard; while NOBODY does, a handed-off arm's armed observer is the
      // only guard left, and the shared followGuardAnchors baseline keeps it
      // idempotent.
      const leaderless = !isLeader(port)
      if (!activeRef.current && followActivePorts.has(port)) return
      if (leaderless && (followLeaders.has(port) || !handedOff)) return
      // Leaderless window: this arm's closure state froze when its loop died.
      // Sync to the shared per-port motion ledger the last live loop wrote,
      // or the applyVisual below would replay stale extent/reserve into the
      // runway and pad ledgers while compensating the cascade.
      if (leaderless) {
        const sharedMotion = followMotionStates.get(port)
        if (sharedMotion !== undefined) {
          animatedH = Math.min(port.scrollHeight, Math.max(0, sharedMotion.extent))
          reservePx = sharedMotion.reservePx
          velocityPxPerSec = sharedMotion.velocityPxPerSec
        }
      }
      // A host keyed replacement can disconnect the element carrying our
      // margin before MutationObserver runs. Drop the stale registry entry;
      // banking it as pad preserves an extent that immediately becomes the
      // slow retirement rebound. The same-task ensureRunway / applyVisual path
      // reopens only the runway that is still needed.
      pruneDeadRunway(port)
      // HOST COMPLETION COMMITS under the pin must be corrected in THIS
      // pre-paint task: the settle loop's rAF guard runs after the host's own
      // follow effects, so a cascade commit (status swap, tail mount) would
      // otherwise paint one frame pinned to the sunk floor. The screen-space
      // anchor hold reads the shared per-port baseline (see
      // followGuardAnchors); it runs for structural commits only and stands
      // down while this settle's retirement glide runs (that motion is ours).
      if (!settleRetiring) {
        const measured = measureReadingAnchor(port)
        if (measured !== null && measured.delta > 0.5) {
          if (pruneDeadRunway(port)) reservePx = 0
          holdGuardAnchor(port, measured, measured.top)
        } else if (measured !== null && measured.delta < -0.5) {
          if (pruneDeadRunway(port)) reservePx = 0
          if (!activeRef.current) {
            // Completion window: pad first, then the shift raise absorbs
            // whatever pad cannot cover (the swap jump rides this path).
            pullReadingAnchorBack(port, measured)
          } else {
            // Live streaming: the original semantics — release only what the
            // pad holds and leave the remainder to the frame loop's own
            // lockstep. A shift raise here would cancel the reveal glide.
            const released = Math.min(flowPadOf(port), -measured.delta)
            if (released > FOLLOW_SETTLE_EPSILON_PX) {
              setFlowPad(port, flowPadOf(port) - released)
              animatedH = Math.max(0, animatedH - released)
            }
            holdGuardAnchor(port, measured, measured.top + released)
          }
        } else if (measured !== null) {
          holdGuardAnchor(port, measured, measured.top)
        }
      }
      // A reveal commit changes the measured tail, not the fixed chrome. Keep
      // the paint-limit TTL intact here; ResizeObserver and viewport/chrome
      // changes invalidate it when the cached geometry is no longer valid.
      // The same-task correction still runs, but ordinary glyph commits do not
      // force a fresh chrome rect read.
      const tuning = debugRuntime.activeTuning()
      const predictGrowth = predictiveRef?.current ?? predictive
      const floor = Math.max(0, port.scrollHeight - port.clientHeight)
      // A wrap or other layout growth changes the real floor and may change the
      // natural tail clearance. Re-measure that boundary; same-floor glyph
      // commits can continue using the cached chrome geometry.
      if (followFloorHistory.get(port) !== floor) invalidatePaintLimit(port)
      const isReasoningSurface = rootRef.current?.querySelector('[data-variant="think"]') !== null
      const trajectoryShift = predictive
        && !isReasoningSurface
        && runwayOffsetOf(port) > 0
        && trajectoryPositionPx !== null
        ? floor - trajectoryPositionPx
        : undefined
      animatedH = applyVisual(
        port,
        animatedH,
        reservePx,
        velocityPxPerSec,
        tuning.runwayPx,
        Number.POSITIVE_INFINITY,
        !predictGrowth,
        trajectoryShift,
        0,
        activeRef.current && !hostOwnsScroll,
      )
      if (trajectoryShift !== undefined) {
        const currentShift = followLastShiftPx.get(port) ?? (floor - (trajectoryPositionPx ?? floor))
        trajectoryPositionPx = floor - currentShift
      }
      updateRevealScale(port, 0, true)
      reportFollow(port, activeRef.current)
      // Host ChatView ResizeObservers may run after this observer and hard-snap
      // to its floor. Re-apply the owned floating top in the same microtask,
      // before the browser's next paint, while scroll-event capture prevents a
      // programmatic write from changing the reader's at-bottom state.
    }

    // Same correction, run synchronously with a reveal commit (see
    // notifyFollowCommit above). Subscribed per-port in bindPort.
    let unsubscribeCommit: (() => void) | null = null

    const bindPort = (next: HTMLElement): void => {
      if (port === next) return
      if (port !== null) {
        for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
        resize?.disconnect()
        mutations?.disconnect()
      }
      unsubscribeCommit?.()
      port = next
      invalidatePaintLimit(port)
      unsubscribeCommit = subscribeFollowCommit(port, () => { restoreBeforePaint() })
      for (const name of GESTURE_EVENTS) {
        port.addEventListener(name, markGesture, { passive: true })
      }
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => restoreBeforePaint())
        resize.observe(port)
        const proxy = resizeProxyOf(port)
        if (proxy !== null) resize.observe(proxy)
      }
      // Completion is chiefly a child-list transaction (status removal,
      // live-to-settled replacement, tail insertion). Because following
      // gives the flow a viewport min-height, those mutations can leave the
      // flow's border box unchanged and never notify ResizeObserver. Observe
      // the transaction itself so the anchor hold still runs before paint.
      if (typeof MutationObserver !== 'undefined') {
        const flow = flowElementOf(port)
        if (flow !== null) {
          mutations = new MutationObserver(() => { restoreBeforePaint() })
          mutations.observe(flow, { childList: true, subtree: true })
        }
      }
    }

    /**
     * Keep the observer on the flow's TAIL surface. A flow locked to the
     * viewport by min-height does not resize when content grows inside it —
     * only the last message row does, and missing that resize means missing
     * the pre-paint correction for that frame's wrap.
     */
    const observeTailSurface = (): void => {
      if (resize === null || port === null) return
      const tail = shiftSurfacesOf(port).at(-1) ?? null
      if (tail === observedTail) return
      if (observedTail !== null) resize.unobserve(observedTail)
      observedTail = tail
      if (tail !== null) resize.observe(tail)
    }

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame)
      // Spring time is clamped so one paint after a stall cannot teleport the
      // transcript. Runway response uses real elapsed time, otherwise long
      // frames would open paint room more slowly precisely when it is needed.
      const elapsedMs = Math.max(0.001, now - last)
      const dt = Math.min(FOLLOW_MAX_FRAME_MS, elapsedMs)
      const tuning = debugRuntime.activeTuning()
      last = now
      const root = rootRef.current
      if (root === null) return
      const nextPort = root.closest<HTMLElement>('[data-conversation-scroll]')
      if (nextPort === null) return
      bindPort(nextPort)
      observeTailSurface()
      resetHostScrollOwnershipForNewTurn(nextPort)
      hostOwnsScroll = followHostScrollPorts.has(nextPort)
      if (activeRef.current) followActivePorts.add(nextPort)
      else followActivePorts.delete(nextPort)
      // A hidden/unmeasured port has no meaningful floor yet. Keep this owner
      // unprimed and let the already-scheduled RAF initialize it after layout.
      if (nextPort.clientHeight <= 0) return

      const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight)
      const reportedLag = floor - nextPort.scrollTop
      const extent = Math.min(
        nextPort.scrollHeight,
        Math.max(0, nextPort.scrollHeight - reportedLag),
      )

      if (!primed) {
        // A completion settle owns this port (the swap remounted this arm in
        // the same frame cluster): stay a passive watcher. Taking over here
        // would zero the pad mid-retirement and re-inherit it as reserve —
        // double-counting the extent for one giant jump.
        if (completionSettleGuardsPort(nextPort)) {
          primed = true
          following = false
          return
        }
        const inherited = nextPort.hasAttribute(FOLLOW_OWNED_ATTR)
          ? followMotionStates.get(nextPort)
          : undefined
        if (inherited === undefined) {
          // A new Agent row is already part of scrollHeight on its first
          // frame. Start at the pre-insert extent so that initial Context and
          // Tool chrome enters through the same spring as later height growth.
          // The predictive runway starts pre-opened at the current reveal
          // pressure: it rides canceled by the equal transform, and waiting
          // out the response ramp would leave the first wraps unpinned.
          const entranceExtent = entrancePending
            ? entranceExtentRef?.current ?? entranceExtentOf(root)
            : 0
          const predictGrowth = predictiveRef?.current ?? predictive
          // Start the entrance at the pre-insert extent, not the raw reported
          // lag: holding the reader's small first-frame offset here would keep
          // the entrance lag above the settle epsilon for ~a second (the
          // spring's advance at single-digit lag is sub-pixel), leaving the
          // entrance arm alive past a settled swap and deferring the
          // completion settle until it finally closes.
          animatedH = entrancePending
            ? Math.max(0, nextPort.scrollHeight - entranceExtent)
            : nextPort.scrollHeight
          // Established before first paint; the matching margin below is
          // written in the same commit, so this held-and-canceled space
          // never moves a pixel.
          const hasStatus = turnStatusOf(nextPort) !== null
          // ZERO-DOWNWARD-REBOUND: the reservation must never land below the
          // margin this port already owns. base = margin − reservation is the
          // painted shift; a reservation smaller than the owned margin would
          // repaint the difference as an instant downward step on this arm's
          // first frame. The margin stays owned (see the growth-only rule in
          // the frame loop), so the reservation opens at least to match it.
          reservePx = Math.max(
            ownedBottomSpaceOf(nextPort),
            predictGrowth && (hasStatus || speedCpsRef.current > FOLLOW_RESERVE_MIN_CPS)
              ? computeFollowReserve(speedCpsRef.current, tuning.runwayPx)
              : 0,
          )
          // Adopt-time reclaim, exactly once and in this same pre-paint task:
          // the previous completion's pad becomes this stream's reserve gap,
          // so the extent — and the pinned floor — never steps between turns.
          // A completion settle still owning the port keeps its ledgers: the
          // swap's remounted arms must not zero the pad mid-retirement.
          if (!completionSettleGuardsPort(nextPort)) setFlowPad(nextPort, 0)
          statusWasPresent = hasStatus
          velocityPxPerSec = 0
          // The committed row/growth delta has already moved the new floor.
          // Decide ownership from READER INTENT EVIDENCE, not raw lag: an
          // upward move recorded past our own ledger is a pull-up; anything
          // else (content that mounted while the host had not re-pinned yet,
          // a completion clamp, first-frame geometry) must keep following,
          // otherwise the whole stream falls back to the host's hard snap.
          void reportedLag
          // A prior follower's reader-release record outranks ledger
          // evidence: its closure died with `following = false` after the
          // release already reset the ledger to the held position, so the
          // delta-based check alone can no longer see the unpin.
          following = !readerScrolledUp(nextPort)
            && !followReaderHolds.has(nextPort)
        } else {
          animatedH = Math.min(nextPort.scrollHeight, inherited.extent)
          reservePx = inherited.reservePx
          velocityPxPerSec = inherited.velocityPxPerSec
          following = true
        }
        if (following) {
          hold(nextPort)
          if (isLeader(nextPort)) {
            animatedH = applyVisual(
              nextPort,
              animatedH,
              reservePx,
              velocityPxPerSec,
              tuning.runwayPx,
              Number.POSITIVE_INFINITY,
              !(predictiveRef?.current ?? predictive),
              undefined,
              0,
              !hostOwnsScroll,
            )
            if (
              predictive
              && root.querySelector('[data-variant="think"]') === null
              && runwayOffsetOf(nextPort) > 0
            ) {
              const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight)
              const requestedMinLagPx = Math.max(
                FOLLOW_TRAJECTORY_MIN_LAG_PX,
                runwayOffsetOf(nextPort) - FOLLOW_TRAJECTORY_PHASE_PX,
              )
              const paintMaxLagPx = Math.max(0, safeShiftLimit(nextPort, shiftSurfacesOf(nextPort)) - FOLLOW_PAINT_GUARD_PX)
              const minLagPx = Math.min(requestedMinLagPx, paintMaxLagPx)
              const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort)
              trajectoryPositionPx = floor - Math.min(paintMaxLagPx, Math.max(minLagPx, currentShift))
              trajectoryTargetVelocityPxPerMs = Math.max(0, speedCpsRef.current) * 0.4 / 1000
              trajectoryVelocityPxPerMs = trajectoryTargetVelocityPxPerMs
              trajectoryFloorPx = floor
              trajectoryGrowthAtMs = now
              trajectoryAccumulatedGrowthPx = 0
              trajectoryAccumulatedGrowthMs = 0
              trajectoryGrowthSamples = 0
              trajectoryWasActive = true
            }
            updateRevealScale(nextPort, elapsedMs)
            reportFollow(nextPort, activeRef.current)
            const runwayOffset = runwayOffsetOf(nextPort)
            const entranceLag = Math.max(0, nextPort.scrollHeight - animatedH - runwayOffset)
            if (entranceLag <= FOLLOW_SETTLE_EPSILON_PX) finishEntrance()
          } else {
            finishEntrance()
          }
        } else {
          finishEntrance()
        }
        primed = true
        return
      }

      const repinSlack = readerReleased ? FOLLOW_REPIN_PX : FOLLOW_SLACK_PX
      const returnedToFloor = readerReleased
        && !readerGestureIntent
        && reportedLag <= FOLLOW_REPIN_PX
      if (!following && (!interacting || returnedToFloor) && reportedLag <= repinSlack) {
        following = true
        readerReleased = false
        followReaderHolds.delete(nextPort)
        animatedH = extent
        reservePx = 0
        velocityPxPerSec = 0
        followScrollLedgers.set(nextPort, nextPort.scrollTop)
        hold(nextPort)
      } else if (following && interacting && (readerGestureIntent || readerScrolledUp(nextPort))) {
        // Directional wheel/touch intent is authoritative even when automatic
        // follow has already overwritten the small physical scroll delta.
        following = false
        readerGestureIntent = false
        readerReleased = true
        followReaderHolds.set(nextPort, { atMs: performance.now() })
        handBackVisual(nextPort)
        animatedH = nextPort.scrollHeight
        reservePx = 0
        velocityPxPerSec = 0
        drop(nextPort)
        finishEntrance()
      }

      if (!activeRef.current || !following) {
        followScrollLedgers.set(nextPort, nextPort.scrollTop)
        reportFollow(nextPort, activeRef.current)
        return
      }
      detectHostScroll(nextPort, floor)
      if (hostOwnsScroll) {
        followScrollLedgers.set(nextPort, nextPort.scrollTop)
        reportFollow(nextPort, false)
        return
      }
      hold(nextPort)
      if (!isLeader(nextPort)) {
        finishEntrance()
        return
      }
      // Runway and an equal transform cancel visually. It is the zero point,
      // not residual motion: decaying below it would scroll past the final
      // resting position and rebound when runway is removed.
      //
      // The reservation scales with reveal pressure — idle holds nothing,
      // because speculative space at rest is a visible defect on handback —
      // but the runway MARGIN tracks the reservation 1:1 in the same frame,
      // so their difference (the only part that can move pixels) stays
      // constant. Growing the reservation without the margin would glide the
      // whole column; growing both together is invisible.
      const predictGrowth = predictiveRef?.current ?? predictive
      const statusElement = turnStatusOf(nextPort)
      const hasStatus = statusElement !== null
      if (statusElement !== null) lastStatusHeightPx = statusElement.offsetHeight
      const statusJustRemoved = predictGrowth && statusWasPresent === true && !hasStatus
      if (statusJustRemoved) {
        // The dying status row takes its own layout height AND the margin
        // riding on it out of the scroll extent in one commit. Re-open the
        // margin on the next surface in the same frame, sized to cover both,
        // or the floor sinks by that height and the transcript slides down
        // under the pin before the replacement margin can land.
        reservePx = Math.max(reservePx, tuning.runwayPx) + lastStatusHeightPx
      }
      statusWasPresent = hasStatus
      const reserveEnabled = hasStatus
        || statusJustRemoved
        || reservePx > FOLLOW_SETTLE_EPSILON_PX
        || speedCpsRef.current > FOLLOW_RESERVE_MIN_CPS
      const pressureReserveTarget = predictGrowth && reserveEnabled
        ? computeFollowReserve(speedCpsRef.current, tuning.runwayPx)
        : 0
      // ZERO-DOWNWARD-REBOUND (root cause): while this follower owns the port
      // it pins scrollTop to the floor, and the floor rides the owned bottom
      // margin 1:1. Shrinking that margin under the pin clamps scrollTop
      // downward and slides the whole transcript down — the one motion this
      // module must never paint; no shift remains to release it because the
      // reservation already covers the margin (base = margin − reservation
      // stays flat). An owned margin therefore only GROWS here: prediction
      // shutdown and reveal-pressure drops freeze it at its current size, and
      // retirement is deferred to reader handback (a user-driven scroll) or
      // the next ownership. Growth stays invisible because the reservation
      // grows in the same frame and the baseline difference never moves.
      const effectiveReserveTarget = Math.max(reservePx, pressureReserveTarget)
      const reserveStep = 1 - Math.exp(-elapsedMs / tuning.reserveResponseMs)
      reservePx += (effectiveReserveTarget - reservePx) * reserveStep
      if (predictGrowth || runwayOffsetOf(nextPort) > 0.5) {
        ensureRunway(nextPort, shiftSurfacesOf(nextPort), reservePx)
      }
      const runwayOffset = runwayOffsetOf(nextPort)
      const contentHeight = nextPort.scrollHeight
      const floorNow = Math.max(0, contentHeight - nextPort.clientHeight)
      const trajectoryActive = predictive
        && root.querySelector('[data-variant="think"]') === null
        && runwayOffset > 0
      let trajectoryShift: number | undefined
      if (trajectoryActive) {
        const requestedMinLagPx = Math.max(
          FOLLOW_TRAJECTORY_MIN_LAG_PX,
          runwayOffset - FOLLOW_TRAJECTORY_PHASE_PX,
        )
        // Phase-band upper bound comes from paint space, not a runway-derived
        // constant: `minLag + 39` can exceed the real gap to status/composer
        // chrome and get clipped into a hard catch-up exactly at the wrap
        // cadence the band exists to absorb (see docs §3.1).
        const paintLimit = safeShiftLimit(nextPort, shiftSurfacesOf(nextPort))
        const maxLagPx = Math.max(0, paintLimit - FOLLOW_PAINT_GUARD_PX)
        const minLagPx = Math.min(requestedMinLagPx, maxLagPx)
        if (trajectoryPositionPx === null || trajectoryFloorPx === null) {
          const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort)
          trajectoryPositionPx = floorNow - Math.min(maxLagPx, Math.max(minLagPx, currentShift))
          trajectoryTargetVelocityPxPerMs = Math.max(0, speedCpsRef.current) * 0.4 / 1000
          trajectoryVelocityPxPerMs = trajectoryTargetVelocityPxPerMs
          trajectoryGrowthAtMs = now
        } else if (floorNow > trajectoryFloorPx + 0.5) {
          const intervalMs = Math.max(1, now - (trajectoryGrowthAtMs ?? now))
          if (trajectoryGrowthSamples > 0) {
            trajectoryAccumulatedGrowthPx += floorNow - trajectoryFloorPx
            trajectoryAccumulatedGrowthMs += intervalMs
            const measuredVelocity = trajectoryAccumulatedGrowthPx
              / trajectoryAccumulatedGrowthMs
            // A single wrap interval is quantized by layout and may also span a
            // dropped frame. Do not replace the trajectory target with that
            // staircase sample: low-pass it over a few wraps so the visual
            // velocity remains continuous when the host is busy or a retry row
            // changes the layout.
            const targetBlend = 1 - Math.exp(-intervalMs / 240)
            trajectoryTargetVelocityPxPerMs += (
              measuredVelocity - trajectoryTargetVelocityPxPerMs
            ) * targetBlend
          }
          trajectoryGrowthSamples += 1
          trajectoryGrowthAtMs = now
        } else if (floorNow < trajectoryFloorPx - 0.5) {
          trajectoryPositionPx = floorNow - minLagPx
          trajectoryGrowthAtMs = now
          trajectoryAccumulatedGrowthPx = 0
          trajectoryAccumulatedGrowthMs = 0
          trajectoryGrowthSamples = 0
        }
        trajectoryFloorPx = floorNow
        const phaseTarget = revealedCharsRef === undefined
          ? floorNow
          : revealPhase.advance(floorNow, revealedCharsRef.current).targetPx
        const trajectoryStep = computeFollowTrajectoryStep(elapsedMs, {
          positionPx: trajectoryPositionPx,
          velocityPxPerMs: trajectoryVelocityPxPerMs,
          targetPx: phaseTarget,
          targetVelocityPxPerMs: trajectoryTargetVelocityPxPerMs,
          minLagPx,
          maxLagPx,
          paintFloorPx: floorNow,
        })
        trajectoryPositionPx = trajectoryStep.positionPx
        trajectoryVelocityPxPerMs = trajectoryStep.velocityPxPerMs
        trajectoryShift = trajectoryStep.shiftPx
        trajectoryWasActive = true
        const baselineShift = runwayOffset - Math.min(runwayOffset, Math.max(0, reservePx))
        animatedH = contentHeight - runwayOffset - Math.max(0, trajectoryShift - baselineShift)
        velocityPxPerSec = trajectoryVelocityPxPerMs * 1000
      } else {
        if (trajectoryWasActive) {
          const currentShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort)
          animatedH = contentHeight - runwayOffset - Math.max(0, currentShift)
          velocityPxPerSec = trajectoryVelocityPxPerMs * 1000
          trajectoryPositionPx = null
          trajectoryWasActive = false
        }
        const lag = Math.max(0, contentHeight - animatedH - runwayOffset)
        const step = computeFollowStep(dt, {
          lag,
          speedEma: speedCpsRef.current,
          velocityPxPerSec,
        }, tuning)
        if (lag <= 0.1) {
          animatedH = contentHeight - runwayOffset
          velocityPxPerSec = 0
        } else {
          // ZERO-DOWNWARD-REBOUND: the reservation is NOT real lag. With the
          // steady-state tail pin it already rides as baseline-canceled gap
          // (shift = margin − reservation + reveal lag), so forcing the spring
          // to stop `reservePx` short of the natural floor — the pre-tail-pin
          // "hold the reserve as lag" semantic — would double-count it and
          // repaint the difference as an instant downward step the moment
          // prediction shuts off. The spring always drains to the natural
          // floor; the painted shift decays through the rate-limited release.
          animatedH = Math.min(
            contentHeight - runwayOffset,
            animatedH + step.advancePx,
          )
          velocityPxPerSec = step.velocityPxPerSec
        }
      }
      animatedH = applyVisual(
        nextPort,
        animatedH,
        reservePx,
        velocityPxPerSec,
        tuning.runwayPx,
        Number.POSITIVE_INFINITY,
        !predictGrowth,
        trajectoryShift,
        elapsedMs,
        !hostOwnsScroll,
      )
      if (trajectoryActive) {
        const currentShift = followLastShiftPx.get(nextPort) ?? (trajectoryShift ?? 0)
        trajectoryPositionPx = floorNow - currentShift
      }
      updateRevealScale(nextPort, elapsedMs)
      reportFollow(nextPort, true)
      // Keep the previous painted tail as the completion handoff baseline.
      // The active loop is the only place that sees the old surface before a
      // host live->settled replacement disconnects it.
      // Per-frame anchor hold — completion window only. During live
      // streaming the lockstep in this very frame's applyVisual already
      // cancels wraps; a guard running here fights it (its pad/raise writes
      // shift the next frame's lag bookkeeping) and visibly degrades the
      // reveal. The completion cascade is different: the settled-side arm
      // that primes IN the swap frame has active=false from mount, so ITS
      // first poll runs before paint and compensates the swap jump that the
      // older arms' observers were too late (or too unprivileged) to fix.
      // Track the reading surface's rendered position so the completion
      // guard inherits the exact last-painted baseline (never a stale or
      // already-jumped one) when the stream hands off. Compensation is NOT
      // done from this poll (a guard beside the active loop's own lockstep
      // fights it and degrades the reveal), and a NON-leader arm must not
      // even refresh the baseline: its measurement would store the very
      // jump the owning guard is about to correct and neutralize its next
      // pass.
      if (isLeader(nextPort)) {
        if (!activeRef.current) enforceReadingAnchor(nextPort)
        else measureReadingAnchor(nextPort)
      }
      const remainingEntranceLag = Math.max(
        0,
        nextPort.scrollHeight - animatedH - runwayOffsetOf(nextPort),
      )
      if (remainingEntranceLag <= FOLLOW_SETTLE_EPSILON_PX) finishEntrance()
    }

    // Prime ownership and the final committed height in this layout phase.
    // A producer-complete text arm can mount and drain before the next RAF;
    // deferring this first pass would let it unmount unprimed after replacing
    // the previous owner, leaving a large final append at the old scrollTop.
    frame(performance.now())
    return () => {
      if (!controlScrollRef.current) {
        cancelAnimationFrame(rafId)
        if (port !== null) followActivePorts.delete(port)
        unsubscribeCommit?.()
        resize?.disconnect()
        mutations?.disconnect()
        if (port !== null) {
          for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
        }
        if (interactTimer !== null) clearTimeout(interactTimer)
        const disabledHost = rootRef.current?.closest<HTMLElement>('[data-conversation-scroll]') ?? port
        if (disabledHost !== null) {
          clearVisual(disabledHost)
          followLeaders.delete(disabledHost)
          debugRuntime.reportFollow(disabledHost, null)
        }
        releaseRevealScale()
        return
      }
      cancelAnimationFrame(rafId)
      if (port !== null) followActivePorts.delete(port)
      unsubscribeCommit?.()
      if (interactTimer !== null) clearTimeout(interactTimer)
      resize?.disconnect()
      mutations?.disconnect()
      if (port !== null) {
        for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
      }
      const root = rootRef.current
      const host = root?.closest<HTMLElement>('[data-conversation-scroll]') ?? port
      if (host === null) return
      holding = null
      if (!isLeader(host)) return
      const preserveReader = interacting && (readerGestureIntent || readerScrolledUp(host))
      if (!following || !primed) {
        if (!following && primed) {
          // A follower that already released the reader must carry that fact
          // across this closure's death: the draining arm mounting after this
          // cleanup would otherwise read the held viewport as its own
          // at-bottom state and hard-snap it to the floor.
          followReaderHolds.set(host, { atMs: performance.now() })
        }
        clearVisual(host)
        followLeaders.delete(host)
        releaseRevealScale()
        debugRuntime.reportFollow(host, null)
        return
      }
      if (preserveReader) {
        handBackVisual(host)
        followReaderHolds.set(host, { atMs: performance.now() })
        clearVisual(host)
        followLeaders.delete(host)
        releaseRevealScale()
        debugRuntime.reportFollow(host, null)
        return
      }

      // Completion can land the final Tool/command height in this same
      // commit. Preserve the logical extent and drain it after unmount instead
      // of clearing the compositor state before the first settled paint.
      // NOTE: do NOT clamp animatedH down by the held reserve here — the
      // reserve is canceled space (base = margin − reservation stays flat),
      // so treating it as real lag paints a whole runway-height step at the
      // exact moment leadership hands to the draining arm. The settle loop
      // caps animatedH against the shrinking extent directly.
      // Settle state (declared before the handoff so the completion paths can
      // measure the extent against it):
      let settleQuietMs = 0
      let settleSig = ''
      const lagBeforeCompletionPaint = Math.max(
        0,
        host.scrollHeight - animatedH - runwayOffsetOf(host),
      )
      const currentRunway = runwayOffsetOf(host)
      const currentShift = Math.abs(currentShiftOf(shiftSurfacesOf(host).at(-1) ?? host))
      if (
        !activeRef.current
        && lagBeforeCompletionPaint <= FOLLOW_SLACK_PX
        && currentRunway <= FOLLOW_SETTLE_EPSILON_PX
        && currentShift <= FOLLOW_SETTLE_EPSILON_PX
        // A live completion pad must retire through the settle's glide first;
        // fast-finishing here would freeze it in place as visible bottom gap.
        && flowPadOf(host) <= FOLLOW_SETTLE_EPSILON_PX
      ) {
        followTraceUntilMs = Math.max(followTraceUntilMs, performance.now() + 10000)
        followTrace('fast-gate', { sh: host.scrollHeight, st: Math.round(host.scrollTop), pad: Math.round(flowPadOf(host)) })
        finishAtNaturalFloor(host, !startedAsEntrance)
        followLeaders.delete(host)
        releaseRevealScale()
        debugRuntime.reportFollow(host, null)
        return
      }
      const completionShift = currentShiftOf(shiftSurfacesOf(host).at(-1) ?? host)
      const completionShiftCeiling = completionShift > FOLLOW_SETTLE_EPSILON_PX
        ? completionShift
        : Number.POSITIVE_INFINITY
      if (hostOwnsScroll) {
        clearVisual(host)
        setFollowScrollTop(host, Math.max(0, host.scrollHeight - host.clientHeight))
        host.removeAttribute(FOLLOW_OWNED_ATTR)
        followLeaders.delete(host)
        releaseRevealScale()
        debugRuntime.reportFollow(host, null)
        return
      }
      // The completion commit often REPLACES the last surface (live→settled
      // swap re-keys the row), and the owned margin written on the old element
      // dies with it in the same layout pass. Do NOT bank that loss as a flow
      // pad: the next ensureRunway opens the completion runway in this same
      // pre-paint task. Converting the dead margin to pad creates a second
      // owned extent that must later retire as the visible "slow rebound".
      followTraceUntilMs = performance.now() + 15000
      if (pruneDeadRunway(host)) {
        followTrace('cleanup-dead-margin', { sh: host.scrollHeight, st: Math.round(host.scrollTop), pad: Math.round(flowPadOf(host)) })
        reservePx = 0
      }
      // The completion handoff keeps at least one real runway open so the
      // final height has reserved paint room to drain through: with zero
      // margin the whole final height lands as shift in ONE paint (offset
      // space collapses to the paint limit), the exact teleport this drain
      // exists to prevent. The draining arm ramps its reserve from here.
      const completionTuning = debugRuntime.activeTuning()
      const previousCompletionRunway = runwayOffsetOf(host)
      // The completion pad already holds retired extent below the fold; the
      // handoff only opens the runway room the pad does not cover, or the
      // same pixels are added twice and the restored floor overshoots.
      ensureRunway(
        host,
        shiftSurfacesOf(host),
        Math.max(reservePx, Math.max(0, completionTuning.runwayPx - flowPadOf(host))),
      )
      const completionRunway = runwayOffsetOf(host)
      // The reading anchor's baseline is already live (the active loop
      // refreshed it every frame, and the guard observers keep it current);
      // only seed it here when this port somehow has none, so the first
      // completion commit has a real screen-space baseline to compare
      // against instead of silently adopting the jumped position.
      measureReadingAnchor(host)
      // Rebase the spring extent onto the new offset domain before the paint:
      // adding the margin drops targetHeight by the same amount, so animatedH
      // must drop in lockstep or the margin's px release as an instant shift.
      animatedH = Math.max(0, animatedH - (completionRunway - previousCompletionRunway))
      if (!hostOwnsScroll) settleAtFloor(host)
      animatedH = applyVisual(
        host,
        animatedH,
        reservePx,
        velocityPxPerSec,
        completionRunway,
        completionShiftCeiling,
        false,
        undefined,
        0,
        !hostOwnsScroll,
      )
      reportFollow(host, false)
      const runwayOffset = runwayOffsetOf(host)
      const remainingLag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
      if (
        remainingLag <= FOLLOW_SETTLE_EPSILON_PX
        && runwayOffset <= FOLLOW_SETTLE_EPSILON_PX
        && reservePx <= FOLLOW_SETTLE_EPSILON_PX
      ) {
        finishAtNaturalFloor(host, !startedAsEntrance, !hostOwnsScroll)
        followLeaders.delete(host)
        releaseRevealScale()
        debugRuntime.reportFollow(host, null)
        return
      }

      for (const name of GESTURE_EVENTS) {
        host.addEventListener(name, markGesture, { passive: true })
      }
      const stopSettleListeners = (): void => {
        for (const name of GESTURE_EVENTS) host.removeEventListener(name, markGesture)
        resize?.disconnect()
        mutations?.disconnect()
        if (interactTimer !== null) {
          clearTimeout(interactTimer)
          interactTimer = null
        }
      }
      // Re-arm pre-paint observation for the whole completion cascade. The
      // active effect's observers were disconnected above, but status/tail
      // commits continue while the detached settle loop owns the port.
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(() => restoreBeforePaint())
        resize.observe(host)
        const proxy = resizeProxyOf(host)
        if (proxy !== null) resize.observe(proxy)
      }
      if (typeof MutationObserver !== 'undefined') {
        const flow = flowElementOf(host)
        if (flow !== null) {
          mutations = new MutationObserver(() => { restoreBeforePaint() })
          mutations.observe(flow, { childList: true, subtree: true })
        }
      }
      // From here this closure's observers are the completion guard of last
      // resort (see `handedOff` above), and this settle OWNS the port until
      // it finishes.
      followCompletionSettle.add(host)
      followCompletionSettleRows.set(host, countUserRows(host))
      handedOff = true
      let settleLast = performance.now()
      // Settle-pad transfer state lives above the completion handoff; the
      // loop below only drives it frame by frame. `settleRetiring` marks the
      // final glide: the cascade has quieted, so the pad that kept every host
      // commit pixel-stable is handed back to the layout at the bounded
      // settle rate and the pinned viewport glides down to the natural
      // resting position against the composer.
      const settleFrame = (now: number): void => {
        if (!isLeader(host)) {
          stopSettleListeners()
          return
        }
        if (interacting && (readerGestureIntent || readerScrolledUp(host))) {
          readerGestureIntent = false
          handBackVisual(host)
          clearVisual(host)
          followCompletionSettle.delete(host)
          followLeaders.delete(host)
          releaseRevealScale()
          debugRuntime.reportFollow(host, null)
          stopSettleListeners()
          return
        }
        const dt = Math.min(FOLLOW_MAX_FRAME_MS, Math.max(0, now - settleLast))
        const tuning = debugRuntime.activeTuning()
        settleLast = now
        detectHostScroll(host, Math.max(0, host.scrollHeight - host.clientHeight))
        if (hostOwnsScroll) {
          clearVisual(host)
          setFollowScrollTop(host, Math.max(0, host.scrollHeight - host.clientHeight))
          host.removeAttribute(FOLLOW_OWNED_ATTR)
          followCompletionSettle.delete(host)
          followLeaders.delete(host)
          releaseRevealScale()
          debugRuntime.reportFollow(host, null)
          stopSettleListeners()
          return
        }
        // HOST COMPLETION CASCADE: around completion the host swaps the status
        // row for its process/tail rows, auto-collapses the think disclosure
        // and mounts the metrics tail — each a same-frame layout shrink under
        // the pinned floor. Re-open every lost pixel below the last surface
        // (out of sight; extent, floor and pinned scrollTop restored) and hold
        // ownership until the cascade has been quiet for
        // FOLLOW_SETTLE_QUIET_MS, so the host's own floor-snap never paints a
        // host action as a single-frame slam of the whole transcript.
        // ANCHOR SCREEN HOLD: the completion cascade moves the reading
        // anchor's viewport position (status swap, live→settled replacement,
        // clamp jumps). The reading-surface baseline lives in the shared
        // followGuardAnchors ledger; the shift-excluded delta filters the
        // engine's own glide, so the per-frame poll only answers real host
        // motion. While the pad retires, extent motion is OUR OWN glide —
        // the hold stands down.
        const guardDelta = !settleRetiring && !followActivePorts.has(host)
          ? enforceReadingAnchor(host, true)
          : null
        settleQuietMs = !settleRetiring && (guardDelta === null || Math.abs(guardDelta) <= 0.5) ? settleQuietMs + dt : 0
        // ZERO-DOWNWARD-REBOUND (root cause): scrollTop is pinned to the floor
        // and the floor rides the owned margin 1:1, so the settle must NOT
        // shrink the margin — that clamps scrollTop downward with no shift
        // left to release (the reservation covers the margin, so base = margin
        // − reservation never moves). Instead the margin MOVES below the
        // status row: marginTop −δ and marginBottom +δ in the same layout
        // pass keep the scroll extent constant, so the floor, the pinned
        // scrollTop and every content pixel stay put while the status glides
        // up to close the reserve gap — the completion 归位, with zero
        // downward motion.
        const settleStatus = turnStatusOf(host)
        const ownedRunwayPx = runwayOffsetOf(host)
        if (ownedRunwayPx > FOLLOW_SETTLE_EPSILON_PX) {
          const requestedTransferPx = settleStatus === null
            ? ownedRunwayPx
            : Math.min(
                reservePx,
                ((tuning.runwayPx || FOLLOW_STATUS_RUNWAY_PX) / FOLLOW_RUNWAY_RETIRE_MS) * dt,
              )
          const transferredPx = transferRunwayToFlowPad(host, requestedTransferPx)
          // Do not bank a completion pad. The margin release and pad removal
          // happen in one layout pass, so there is no extra extent to retire
          // later and no second slow rebound after the cascade quiets.
          if (transferredPx > 0) setFlowPad(host, Math.max(0, flowPadOf(host) - transferredPx))
          reservePx = Math.max(0, reservePx - transferredPx)
          // targetHeight = scrollHeight - runway. The equal margin-to-pad
          // transfer keeps scrollHeight fixed and lowers runway by δ, so the
          // logical extent rises by exactly δ (not 2δ). Both this rebase and
          // applyVisual's offset-history rebase are required: dropping either
          // one stalls the spring or leaks residual motion into the quiet
          // window (audit burst-gap/ramp quiescence-move).
          animatedH += transferredPx
        }
        const runwayOffset = runwayOffsetOf(host)
        const lag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
        // PAD RETIREMENT (the final glide of 收尾归位): cascade quiet, drain
        // closed — the pad that kept every host commit pixel-stable is handed
        // back to the layout at the bounded settle rate. The floor sinks with
        // it and the pinned viewport glides down to the natural resting
        // position against the composer; smooth and rate-limited, never the
        // single-frame slam the raw host snap paints.
        if (
          !settleRetiring
          && lag <= FOLLOW_SETTLE_EPSILON_PX
          && reservePx <= FOLLOW_SETTLE_EPSILON_PX
          && settleQuietMs >= FOLLOW_SETTLE_QUIET_MS
          && flowPadOf(host) > FOLLOW_SETTLE_EPSILON_PX
        ) {
          followTrace('retire-start', { pad: Math.round(flowPadOf(host)), sh: host.scrollHeight, st: Math.round(host.scrollTop) })
          settleRetiring = true
        }
        if (settleRetiring) {
          const padPx = flowPadOf(host)
          const retirePx = Math.min(
            padPx,
            ((tuning.runwayPx || FOLLOW_STATUS_RUNWAY_PX) / FOLLOW_RUNWAY_RETIRE_MS) * dt,
          )
          if (padPx - retirePx <= FOLLOW_SETTLE_EPSILON_PX) {
            setFlowPad(host, 0)
            settleRetiring = false
          } else {
            setFlowPad(host, padPx - retirePx)
          }
        }
        if (
          lag <= FOLLOW_SETTLE_EPSILON_PX
          && (reservePx <= FOLLOW_SETTLE_EPSILON_PX || settleStatus === null)
          && flowPadOf(host) <= FOLLOW_SETTLE_EPSILON_PX
          && settleQuietMs >= FOLLOW_SETTLE_QUIET_MS
        ) {
          followTrace('finish', { st: Math.round(host.scrollTop), sh: host.scrollHeight, pad: Math.round(flowPadOf(host)) })
          animatedH = host.scrollHeight
          velocityPxPerSec = 0
          finishAtNaturalFloor(host, !startedAsEntrance, !hostOwnsScroll)
          followLeaders.delete(host)
          releaseRevealScale()
          debugRuntime.reportFollow(host, null)
          stopSettleListeners()
          return
        }
        const step = computeFollowStep(dt, {
          lag,
          speedEma: speedCpsRef.current,
          velocityPxPerSec,
        }, tuning)
        animatedH = Math.min(
          host.scrollHeight - runwayOffset,
          animatedH + step.advancePx,
        )
        velocityPxPerSec = step.velocityPxPerSec
        if (!hostOwnsScroll) settleAtFloor(host)
        // Once the host has written, never write scrollTop again. The settle
        // still computes compositor shifts and rebases the spring; the host
        // owns the scrollport. A completion commit that GROWS the extent
        // changes the host floor; the host snaps while applyVisual answers
        // with the matching shift raise — the same lockstep the active loop
        // paints for a wrap.
        animatedH = applyVisual(
          host,
          animatedH,
          reservePx,
          velocityPxPerSec,
          runwayOffset,
          Number.POSITIVE_INFINITY,
          false,
          undefined,
          0,
          !hostOwnsScroll,
        )
        if (traceActive()) {
          const sig = `${Math.round(host.scrollTop)}|${host.scrollHeight}|${Math.round(flowPadOf(host))}|${Math.round(reservePx)}|${settleRetiring}`
          if (sig !== settleSig) {
            followTrace('settle', { st: Math.round(host.scrollTop), sh: host.scrollHeight, pad: Math.round(flowPadOf(host)), reserve: Math.round(reservePx), lag: Math.round(lag * 10) / 10, retiring: settleRetiring })
            settleSig = sig
          }
        }
        reportFollow(host, false)
        requestAnimationFrame(settleFrame)
      }
      requestAnimationFrame(settleFrame)
    }
  }, [active, rootRef, speedCpsRef, revealScaleRef, predictive, predictiveRef, controlScroll])

  useLayoutEffect(() => {
    const host = rootRef.current?.closest<HTMLElement>('[data-conversation-scroll]') ?? null
    if (host !== null) {
      followFlowFillUsers.set(host, (followFlowFillUsers.get(host) ?? 0) + 1)
    }
    return () => {
      if (host === null) return
      const remaining = Math.max(0, (followFlowFillUsers.get(host) ?? 1) - 1)
      if (remaining > 0) {
        followFlowFillUsers.set(host, remaining)
        return
      }
      followFlowFillUsers.delete(host)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!followLeaders.has(host) && !followFlowFillUsers.has(host)) restoreFlowFill(host)
        })
      })
    }
  }, [rootRef])
}
