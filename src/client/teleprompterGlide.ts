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

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

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
export const FOLLOW_RESERVE_MIN_PX = 16

/** Reveal-speed range produced by the pressure-buffer typewriter. */
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
 * Maximum predictive paint room before status/composer chrome. One rendered
 * line is normally 24-28px; 48px plus the host's existing status gap covers
 * the original spring's measured ~63px worst-case trail at 600cps.
 */
export const FOLLOW_STATUS_RUNWAY_PX = 48

/** How long a gesture keeps `isUserInteracting` so the next scroll can unpin. */
export const FOLLOW_GESTURE_MS = 800

/** Sub-pixel settle threshold; clearing below this cannot produce a visible rebound. */
export const FOLLOW_SETTLE_EPSILON_PX = 0.25

/** Lowest reveal rate retained while the spring is short on paint room. */
export const FOLLOW_REVEAL_MIN_SCALE = 0.55

/** Safe-lag occupancy band over which reveal pressure is progressively reduced. */
export const FOLLOW_BACKPRESSURE_START_RATIO = 0.25
export const FOLLOW_BACKPRESSURE_FULL_RATIO = 0.75

/** Slow release prevents the reveal rate from oscillating around each wrap. */
export const FOLLOW_BACKPRESSURE_RELEASE_MS = 240

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
export function computeFollowReserve(speedCps: number, runwayPx = FOLLOW_STATUS_RUNWAY_PX): number {
  const available = Math.max(0, runwayPx)
  if (available <= 0) return 0
  if (speedCps <= FOLLOW_RESERVE_MIN_CPS) return 0
  const normalized = Math.min(1, Math.max(0, (
    speedCps - FOLLOW_RESERVE_MIN_CPS
  ) / (FOLLOW_RESERVE_MAX_CPS - FOLLOW_RESERVE_MIN_CPS)))
  const minimum = Math.min(available, FOLLOW_RESERVE_MIN_PX)
  return minimum + normalized * (available - minimum)
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
): number {
  if (constrained) return FOLLOW_REVEAL_MIN_SCALE
  if (!Number.isFinite(capacityPx)) return 1
  if (capacityPx <= 0) return lagPx > 0 ? FOLLOW_REVEAL_MIN_SCALE : 1
  const ratio = Math.min(1, Math.max(0, lagPx / capacityPx))
  if (ratio >= FOLLOW_BACKPRESSURE_FULL_RATIO) return FOLLOW_REVEAL_MIN_SCALE
  const progress = Math.min(1, Math.max(0, (
    ratio - FOLLOW_BACKPRESSURE_START_RATIO
  ) / (FOLLOW_BACKPRESSURE_FULL_RATIO - FOLLOW_BACKPRESSURE_START_RATIO)))
  const eased = progress * progress * (3 - 2 * progress)
  return 1 - (1 - FOLLOW_REVEAL_MIN_SCALE) * eased
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

/**
 * Semi-implicit spring integration with four substeps per <=32ms slice.
 * @param dtMs - Frame delta in ms.
 * @param input - Current visible lag and carried physics velocity.
 * @returns The position advance, its fraction, and next velocity.
 */
export function computeFollowStep(dtMs: number, input: FollowGlideInput): FollowGlideStep {
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
        FOLLOW_SPRING_STIFFNESS * lag - FOLLOW_SPRING_DAMPING * velocity
      ) / FOLLOW_SPRING_MASS
      velocity = Math.max(0, velocity + acceleration * subDt)
      const advance = velocity * subDt
      if (advance >= lag) {
        return { advancePx: input.lag, lerpStep: 1, velocityPxPerSec: 0 }
      }
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

/** Outermost message surfaces; nested tool rows ride their parent. */
function shiftSurfacesOf(port: HTMLElement): HTMLElement[] {
  const transcript = port.querySelector<HTMLElement>('[data-chat-transcript]')
  if (transcript !== null) return [transcript]
  return [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
    .filter(row => row.parentElement?.closest('[data-chat-anchor-key]') === null)
}

function currentShiftOf(element: HTMLElement): number {
  return Number(
    /translate3d\(0(?:px)?,\s*(-?[\d.]+)px,\s*0(?:px)?\)/.exec(element.style.transform)?.[1] ?? 0,
  )
}

function setShift(element: HTMLElement, px: number): void {
  if (Math.abs(px) > 0.01) {
    if (
      Math.abs(currentShiftOf(element) - px) <= 0.01
      && element.style.willChange === 'transform'
      && element.style.clipPath === ''
    ) {
      return
    }
    element.style.transform = `translate3d(0, ${px}px, 0)`
    element.style.willChange = 'transform'
  } else {
    if (element.style.transform === '' && element.style.willChange === '' && element.style.clipPath === '') return
    element.style.transform = ''
    element.style.willChange = ''
  }
  // Remove paint state left by v0.3.2 and earlier experimental builds.
  element.style.clipPath = ''
}

function turnStatusOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector<HTMLElement>(
    '[data-chat-turn-status], [data-chat-flow] > [role="status"]',
  )
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
  return terms.every(([, raw]) => {
    const px = Number(raw)
    return Number.isFinite(px)
      && px >= FOLLOW_STATUS_RUNWAY_PX
      && Math.abs(px % FOLLOW_STATUS_RUNWAY_PX) <= Number.EPSILON
  })
}

/** Remove unowned runway residue written by v0.3.3 and earlier bundles. */
function migrateLegacyRunway(
  port: HTMLElement,
  surfaces: readonly HTMLElement[],
  status: HTMLElement | null,
  composer: HTMLElement | null,
): void {
  if (followRunways.has(port)) return
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
}

function ensureRunway(port: HTMLElement, surfaces: readonly HTMLElement[]): void {
  const status = turnStatusOf(port)
  const composer = port.querySelector<HTMLElement>('[data-composer-seat]')
  migrateLegacyRunway(port, surfaces, status, composer)
  // A runway is useful only after the natural conversation already has a
  // scroll floor for its equal message transform to ride. Before that point
  // applyVisual keeps every surface in normal flow, so adding status margin
  // would expose the whole runway as empty space below a short/early Think.
  const naturalHeight = Math.max(0, port.scrollHeight - runwayOffsetOf(port))
  if (port.clientHeight <= 0 || naturalHeight <= port.clientHeight) {
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
  if (current?.element === element && current.property === target.property) return
  restoreRunway(port)
  const beforeHeight = port.scrollHeight
  const original = element.style[target.property]
  element.style[target.property] = original === ''
    ? `${FOLLOW_STATUS_RUNWAY_PX}px`
    : `calc(${original} + ${FOLLOW_STATUS_RUNWAY_PX}px)`
  const offset = Math.max(0, port.scrollHeight - beforeHeight)
  followRunways.set(port, { element, offset, property: target.property, original })
  invalidatePaintLimit(port)
}

function runwayOffsetOf(port: HTMLElement): number {
  return followRunways.get(port)?.offset ?? 0
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
      ? Number.POSITIVE_INFINITY
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
): number {
  const surfaces = shiftSurfacesOf(port)
  ensureRunway(port, surfaces)
  const contentHeight = Math.max(0, port.scrollHeight)
  const runwayOffset = runwayOffsetOf(port)
  const targetHeight = Math.max(0, contentHeight - runwayOffset)
  const floor = Math.max(0, contentHeight - port.clientHeight)
  const extent = Math.min(targetHeight, Math.max(0, animatedH))
  if (port.style.overflowAnchor !== 'none') port.style.overflowAnchor = 'none'
  if (port.style.scrollBehavior !== 'auto') port.style.scrollBehavior = 'auto'
  if (floor <= 0) {
    setFollowScrollTop(port, 0)
    followMotionStates.set(port, {
      capacityPx: Number.POSITIVE_INFINITY,
      constrained: false,
      extent: targetHeight,
      lagPx: 0,
      reservePx: 0,
      velocityPxPerSec: 0,
    })
    for (const surface of surfaces) setShift(surface, 0)
    const status = turnStatusOf(port)
    if (status !== null) setShift(status, 0)
    return targetHeight
  }
  // Measure paint room at the real floor. This write and the final physical
  // position land in the same animation frame, so only the latter is painted.
  setFollowScrollTop(port, floor)
  const limit = floor > 0 ? safeShiftLimit(port, surfaces) : 0
  const visibleReserve = Math.min(runwayOffset, Math.max(0, reservePx))
  const baselineShift = runwayOffset - visibleReserve
  const requestedLag = Math.max(0, targetHeight - extent)
  const shift = Math.min(baselineShift + requestedLag, Math.max(0, limit))
  const effectiveLag = Math.max(0, shift - baselineShift)
  const capacityPx = Math.max(0, limit - baselineShift)
  const effectiveExtent = targetHeight - effectiveLag
  followMotionStates.set(port, {
    capacityPx,
    constrained: requestedLag > effectiveLag + FOLLOW_SETTLE_EPSILON_PX,
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
  invalidatePaintLimit(port)
}

/** Keep an already-promoted surface at zero until one stable final paint lands. */
function holdCompositorAtRest(element: HTMLElement): void {
  element.style.transform = 'translate3d(0, 0px, 0)'
  element.style.willChange = 'transform'
  element.style.clipPath = ''
}

/** Remove equal offsets, land on the floor, then retire the compositor quietly. */
function finishAtNaturalFloor(port: HTMLElement): void {
  const surfaces = shiftSurfacesOf(port)
  const status = turnStatusOf(port)
  const promoted = [...surfaces, ...(status === null ? [] : [status])]
    .filter(element => element.style.transform !== '' || element.style.willChange === 'transform')
  const promotedSet = new Set(promoted)
  restoreRunway(port)
  settleAtFloor(port)
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
      if (port.hasAttribute(FOLLOW_OWNED_ATTR)) return
      for (const element of promoted) {
        if (Math.abs(currentShiftOf(element)) <= 0.01) setShift(element, 0)
      }
    })
  })
}

function settleAtFloor(port: HTMLElement): void {
  const floor = Math.max(0, port.scrollHeight - port.clientHeight)
  setFollowScrollTop(port, floor)
}

interface FollowLeader {
  readonly generation: number
  readonly owner: object
}

/** Only the newest active follower may write one port's shared visual state. */
const followLeaders = new WeakMap<HTMLElement, FollowLeader>()
let followGeneration = 0

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
): void {
  const activeRef = useRef(active)
  const entranceRef = useRef(entrance)
  const onEntranceSettledRef = useRef(onEntranceSettled)
  entranceRef.current = entrance
  onEntranceSettledRef.current = onEntranceSettled
  useEffect(() => {
    activeRef.current = active
  }, [active])

  useLayoutEffect(() => {
    if (!active) return
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
    let holding: HTMLElement | null = null
    let entrancePending = entranceRef.current

    const finishEntrance = (): void => {
      if (!entrancePending) return
      entrancePending = false
      onEntranceSettledRef.current?.()
    }

    const updateRevealScale = (next: HTMLElement, elapsedMs: number, urgent = false): void => {
      if (revealScaleRef === undefined) return
      const state = followMotionStates.get(next)
      const target = state === undefined
        ? 1
        : computeFollowRevealScale(state.lagPx, state.capacityPx, state.constrained)
      const current = Math.min(1, Math.max(FOLLOW_REVEAL_MIN_SCALE, revealScaleRef.current))
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

    const isLeader = (next: HTMLElement): boolean => followLeaders.get(next)?.owner === owner

    const hold = (next: HTMLElement): void => {
      followActivityAt.set(next, performance.now())
      if (holding === next && isLeader(next)) return
      holding = next
      const leader = followLeaders.get(next)
      if (leader === undefined || generation > leader.generation) {
        followLeaders.set(next, { generation, owner })
      }
    }

    const drop = (next: HTMLElement): void => {
      if (holding === next) holding = null
      if (isLeader(next)) {
        clearMotion(next)
        followMotionStates.delete(next)
        releaseRevealScale()
      }
    }

    const handBackVisual = (next: HTMLElement): void => {
      const shift = currentShiftOf(shiftSurfacesOf(next).at(-1) ?? next)
      const visualTop = Math.max(0, next.scrollTop - Math.max(0, shift))
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

    const restoreBeforePaint = (): void => {
      if (!following || port === null || !isLeader(port)) return
      invalidatePaintLimit(port)
      animatedH = applyVisual(port, animatedH, reservePx, velocityPxPerSec)
      updateRevealScale(port, 0, true)
    }

    const bindPort = (next: HTMLElement): void => {
      if (port === next) return
      if (port !== null) {
        for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
        resize?.disconnect()
      }
      port = next
      invalidatePaintLimit(port)
      for (const name of GESTURE_EVENTS) {
        port.addEventListener(name, markGesture, { passive: true })
      }
      if (typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(restoreBeforePaint)
        resize.observe(port)
        const proxy = resizeProxyOf(port)
        if (proxy !== null) resize.observe(proxy)
      }
    }

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame)
      // Spring time is clamped so one paint after a stall cannot teleport the
      // transcript. Runway response uses real elapsed time, otherwise long
      // frames would open paint room more slowly precisely when it is needed.
      const elapsedMs = Math.max(0.001, now - last)
      const dt = Math.min(FOLLOW_MAX_FRAME_MS, elapsedMs)
      last = now
      const root = rootRef.current
      if (root === null) return
      const nextPort = root.closest<HTMLElement>('[data-conversation-scroll]')
      if (nextPort === null) return
      bindPort(nextPort)
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
        const inherited = nextPort.hasAttribute(FOLLOW_OWNED_ATTR)
          ? followMotionStates.get(nextPort)
          : undefined
        if (inherited === undefined) {
          // A new Agent row is already part of scrollHeight on its first
          // frame. Start at the pre-insert extent so that initial Context and
          // Tool chrome enters through the same spring as later height growth.
          const entranceExtent = entrancePending
            ? entranceExtentRef?.current ?? entranceExtentOf(root)
            : 0
          animatedH = Math.max(0, nextPort.scrollHeight - entranceExtent)
          reservePx = 0
          velocityPxPerSec = 0
          // The committed row/growth delta has already moved the new floor.
          // Decide ownership from the reader's position before that delta;
          // otherwise any atomic result taller than FOLLOW_SLACK_PX looks
          // indistinguishable from an intentional reader pull-up.
          const lagBeforeEntrance = Math.max(0, reportedLag - entranceExtent)
          following = lagBeforeEntrance <= FOLLOW_SLACK_PX
        } else {
          animatedH = Math.min(nextPort.scrollHeight, inherited.extent)
          reservePx = inherited.reservePx
          velocityPxPerSec = inherited.velocityPxPerSec
          following = true
        }
        if (following) {
          hold(nextPort)
          if (isLeader(nextPort)) {
            animatedH = applyVisual(nextPort, animatedH, reservePx, velocityPxPerSec)
            updateRevealScale(nextPort, elapsedMs)
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
      if (!following && !interacting && reportedLag <= repinSlack) {
        following = true
        readerReleased = false
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
        handBackVisual(nextPort)
        animatedH = nextPort.scrollHeight
        reservePx = 0
        velocityPxPerSec = 0
        drop(nextPort)
        finishEntrance()
      }

      if (!activeRef.current || !following) {
        followScrollLedgers.set(nextPort, nextPort.scrollTop)
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
      const runwayOffset = runwayOffsetOf(nextPort)
      const contentHeight = nextPort.scrollHeight
      const lag = Math.max(0, contentHeight - animatedH - runwayOffset)
      const predictGrowth = predictiveRef?.current ?? predictive
      const reserveTarget = !predictGrowth
        ? 0
        : computeFollowReserve(speedCpsRef.current, runwayOffset)
      const reserveStep = 1 - Math.exp(-elapsedMs / FOLLOW_RESERVE_RESPONSE_MS)
      reservePx += (reserveTarget - reservePx) * reserveStep
      const step = computeFollowStep(dt, {
        lag,
        speedEma: speedCpsRef.current,
        velocityPxPerSec,
      })
      if (lag <= 0.1) {
        animatedH = contentHeight - runwayOffset
        velocityPxPerSec = 0
      } else {
        const minimumLag = predictGrowth ? 0 : Math.max(0, reservePx)
        animatedH = Math.min(
          contentHeight - runwayOffset - minimumLag,
          animatedH + step.advancePx,
        )
        velocityPxPerSec = step.velocityPxPerSec
      }
      animatedH = applyVisual(nextPort, animatedH, reservePx, velocityPxPerSec)
      updateRevealScale(nextPort, elapsedMs)
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
      cancelAnimationFrame(rafId)
      if (interactTimer !== null) clearTimeout(interactTimer)
      resize?.disconnect()
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
        clearVisual(host)
        followLeaders.delete(host)
        releaseRevealScale()
        return
      }
      if (preserveReader) {
        handBackVisual(host)
        clearVisual(host)
        followLeaders.delete(host)
        releaseRevealScale()
        return
      }

      // Completion can land the final Tool/command height in this same
      // commit. Preserve the logical extent and drain it after unmount instead
      // of clearing the compositor state before the first settled paint.
      ensureRunway(host, shiftSurfacesOf(host))
      const completionRunway = runwayOffsetOf(host)
      const completionMinimumLag = Math.max(0, reservePx)
      animatedH = Math.min(
        animatedH,
        host.scrollHeight - completionRunway - completionMinimumLag,
      )
      settleAtFloor(host)
      animatedH = applyVisual(host, animatedH, reservePx, velocityPxPerSec)
      const runwayOffset = runwayOffsetOf(host)
      const remainingLag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
      if (remainingLag <= FOLLOW_SETTLE_EPSILON_PX && reservePx <= FOLLOW_SETTLE_EPSILON_PX) {
        finishAtNaturalFloor(host)
        followLeaders.delete(host)
        releaseRevealScale()
        return
      }

      for (const name of GESTURE_EVENTS) {
        host.addEventListener(name, markGesture, { passive: true })
      }
      const stopSettleListeners = (): void => {
        for (const name of GESTURE_EVENTS) host.removeEventListener(name, markGesture)
        if (interactTimer !== null) {
          clearTimeout(interactTimer)
          interactTimer = null
        }
      }
      let settleLast = performance.now()
      const settleFrame = (now: number): void => {
        if (!isLeader(host)) {
          stopSettleListeners()
          return
        }
        if (interacting && (readerGestureIntent || readerScrolledUp(host))) {
          readerGestureIntent = false
          handBackVisual(host)
          clearVisual(host)
          followLeaders.delete(host)
          releaseRevealScale()
          stopSettleListeners()
          return
        }
        const dt = Math.min(FOLLOW_MAX_FRAME_MS, Math.max(0, now - settleLast))
        settleLast = now
        const runwayOffset = runwayOffsetOf(host)
        const lag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
        const reserveStep = 1 - Math.exp(-dt / FOLLOW_RESERVE_RESPONSE_MS)
        reservePx += (0 - reservePx) * reserveStep
        if (lag <= FOLLOW_SETTLE_EPSILON_PX && reservePx <= FOLLOW_SETTLE_EPSILON_PX) {
          animatedH = host.scrollHeight - runwayOffset
          reservePx = 0
          velocityPxPerSec = 0
          finishAtNaturalFloor(host)
          followLeaders.delete(host)
          releaseRevealScale()
          stopSettleListeners()
          return
        }
        const step = computeFollowStep(dt, {
          lag,
          speedEma: speedCpsRef.current,
          velocityPxPerSec,
        })
        // The temporary runway is visually neutral only while an equal lag
        // remains in the transform. Do not let the spring outrun the runway's
        // closing reserve or cleanup would reveal an overshoot and rebound.
        const minimumLag = Math.max(0, reservePx)
        animatedH = Math.min(
          host.scrollHeight - runwayOffset - minimumLag,
          animatedH + step.advancePx,
        )
        velocityPxPerSec = step.velocityPxPerSec
        settleAtFloor(host)
        animatedH = applyVisual(host, animatedH, reservePx, velocityPxPerSec)
        requestAnimationFrame(settleFrame)
      }
      requestAnimationFrame(settleFrame)
    }
  }, [active, rootRef, speedCpsRef, revealScaleRef, predictive, predictiveRef])
}
