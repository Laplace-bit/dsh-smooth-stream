/**
 * Conversation-port follow while an assistant reply streams.
 *
 * A sub-stepped spring physics engine drives a float `animatedH`, rather
 * than restarting native smooth-scroll animations as every glyph lands.
 * Remaining lag is split between the scroll position and a small compositor
 * transform, so a full line can enter the spring even when there is only a
 * narrow safe paint gap before sticky conversation chrome. This follower:
 *
 * - marks programmatic writes via `data-follow-owned` for compatible hosts;
 * - sets `overflow-anchor: none` so CSS scroll-anchoring does not snap;
 * - restores `animatedH` in a ResizeObserver (before paint) so a layout
 *   pass cannot flash a snapped frame;
 * - expresses safe lag as a compositor transform on message rows;
 * - carries any excess lag in the physical scroll position and counter-shifts
 *   turn status, so chrome stays fixed without dropping a whole line at once;
 * - never clips or overlays streamed text.
 *
 * A real reader gesture receives the effective visual position before the
 * transform clears. Lifecycle completion instead settles at the floor.
 *
 * Unpin is a real gesture (wheel / touch / pointer / key) that leaves the
 * floor; a `scrollTop` delta from our own write must not release the pin.
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
 * Upward wheel/touch distance that releases the pin. The engine stays at the
 * floor while following, so only explicit input can distinguish reader intent
 * from programmatic scroll delivery.
 */
export const FOLLOW_UNPIN_GESTURE_PX = 8

/** Sub-pixel paint guard before status/composer chrome. */
export const FOLLOW_PAINT_GUARD_PX = 1

/** Extra layout room, restoring one full 28px line of glide around chrome. */
export const FOLLOW_STATUS_RUNWAY_PX = 16

/** How long a gesture keeps `isUserInteracting` so the next scroll can unpin. */
export const FOLLOW_GESTURE_MS = 800

const GESTURE_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

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

interface FollowRunway {
  readonly element: HTMLElement
  readonly offset: number
  readonly original: string
  readonly property: 'marginBottom' | 'marginTop'
}

const followRunways = new WeakMap<HTMLElement, FollowRunway>()

interface FollowPaintLimit {
  readonly clientHeight: number
  readonly contentHeight: number
  readonly limit: number
  readonly composer: HTMLElement | null
  readonly status: HTMLElement | null
  readonly surface: HTMLElement | undefined
}

/**
 * A rect read can force a layout flush. The usable space only changes when
 * the flow/viewport grows, its chrome changes, or a ResizeObserver fires, so
 * retain it across ordinary glyph frames.
 */
const followPaintLimits = new WeakMap<HTMLElement, FollowPaintLimit>()

function invalidatePaintLimit(port: HTMLElement): void {
  followPaintLimits.delete(port)
}

interface FollowMotionState {
  readonly extent: number
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

function ensureRunway(port: HTMLElement, surfaces: readonly HTMLElement[]): void {
  const status = turnStatusOf(port)
  const composer = port.querySelector<HTMLElement>('[data-composer-seat]')
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
  contentHeight: number,
): number {
  const last = surfaces.at(-1)
  if (last === undefined) return 0
  const status = turnStatusOf(port)
  const composer = port.querySelector<HTMLElement>('[data-composer-seat]')
  const cached = followPaintLimits.get(port)
  if (
    cached?.contentHeight === contentHeight
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
  if (ceiling === undefined) return 0
  const ceilingTop = ceiling.rect.top
  const naturalBottom = last.getBoundingClientRect().bottom - currentShiftOf(last)
  const limit = Math.max(0, ceilingTop - naturalBottom - FOLLOW_PAINT_GUARD_PX)
  followPaintLimits.set(port, {
    clientHeight: port.clientHeight,
    contentHeight,
    limit,
    composer,
    status,
    surface: last,
  })
  return limit
}

function setFollowScrollTop(port: HTMLElement, nextTop: number): void {
  if (Math.abs(port.scrollTop - nextTop) > 0.01) port.scrollTop = nextTop
  const ownedTop = String(port.scrollTop)
  if (port.getAttribute(FOLLOW_OWNED_ATTR) !== ownedTop) {
    port.setAttribute(FOLLOW_OWNED_ATTR, ownedTop)
  }
}

/** Split visual lag between physical scroll and safe compositor translation. */
function applyVisual(
  port: HTMLElement,
  animatedH: number,
  maxShift = Number.POSITIVE_INFINITY,
  velocityPxPerSec = 0,
): void {
  const surfaces = shiftSurfacesOf(port)
  ensureRunway(port, surfaces)
  const contentHeight = Math.max(0, port.scrollHeight)
  const floor = Math.max(0, contentHeight - port.clientHeight)
  const extent = Math.min(contentHeight, Math.max(0, animatedH))
  if (port.style.overflowAnchor !== 'none') port.style.overflowAnchor = 'none'
  if (port.style.scrollBehavior !== 'auto') port.style.scrollBehavior = 'auto'
  if (floor <= 0) {
    setFollowScrollTop(port, 0)
    followMotionStates.set(port, { extent, velocityPxPerSec })
    for (const surface of surfaces) setShift(surface, 0)
    const status = turnStatusOf(port)
    if (status !== null) setShift(status, 0)
    return
  }
  // Measure paint room at the real floor. This write and the final physical
  // position land in the same animation frame, so only the latter is painted.
  setFollowScrollTop(port, floor)
  const limit = floor > 0 ? safeShiftLimit(port, surfaces, contentHeight) : 0
  const totalLag = Math.max(0, contentHeight - extent)
  const runwayShift = Math.min(totalLag, runwayOffsetOf(port))
  const motionLag = totalLag - runwayShift
  const safeMotionShift = Math.min(
    motionLag,
    Math.max(0, limit - runwayShift),
    Math.max(0, maxShift - runwayShift),
  )
  const shift = runwayShift + safeMotionShift
  const scrollLag = motionLag - safeMotionShift
  setFollowScrollTop(port, Math.max(0, floor - scrollLag))
  followMotionStates.set(port, { extent, velocityPxPerSec })
  for (const surface of surfaces) setShift(surface, shift)
  const status = turnStatusOf(port)
  if (status !== null) setShift(status, -scrollLag)
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

/** Remove equal layout/transform offsets in one frame, then land on the real floor. */
function finishAtNaturalFloor(port: HTMLElement): void {
  restoreRunway(port)
  settleAtFloor(port)
  clearMotion(port)
  followMotionStates.delete(port)
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
 */
export function useConversationFollow(
  rootRef: RefObject<HTMLElement | null>,
  active: boolean,
  speedCpsRef: { current: number },
): void {
  const activeRef = useRef(active)
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
    let velocityPxPerSec = 0
    let interacting = false
    let interactTimer: ReturnType<typeof setTimeout> | null = null
    let port: HTMLElement | null = null
    let resize: ResizeObserver | null = null
    let holding: HTMLElement | null = null
    let awayPx = 0
    let maxShift = Number.POSITIVE_INFINITY
    let lastContentHeight = 0

    const isLeader = (next: HTMLElement): boolean => followLeaders.get(next)?.owner === owner

    const hold = (next: HTMLElement): void => {
      if (holding === next) return
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
      }
    }

    const handBackVisual = (next: HTMLElement): void => {
      const shift = currentShiftOf(shiftSurfacesOf(next).at(-1) ?? next)
      if (shift <= 0) return
      next.scrollTop = Math.max(0, next.scrollTop - shift)
    }

    const markGesture = (event: Event): void => {
      interacting = true
      if (event instanceof WheelEvent && event.deltaY < 0) awayPx += -event.deltaY
      else if (event.type === 'touchmove' || event.type === 'keydown') awayPx += FOLLOW_UNPIN_GESTURE_PX
      if (interactTimer !== null) clearTimeout(interactTimer)
      interactTimer = setTimeout(() => {
        interacting = false
        interactTimer = null
        awayPx = 0
      }, FOLLOW_GESTURE_MS)
    }

    const restoreBeforePaint = (): void => {
      if (!following || port === null || !isLeader(port)) return
      invalidatePaintLimit(port)
      applyVisual(port, animatedH, maxShift, velocityPxPerSec)
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
      const dt = Math.min(FOLLOW_MAX_FRAME_MS, Math.max(0, now - last))
      last = now
      const root = rootRef.current
      if (root === null) return
      const nextPort = root.closest<HTMLElement>('[data-conversation-scroll]')
      if (nextPort === null) return
      bindPort(nextPort)

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
          // Entering follow inside the reader-return slack is an intentional
          // snap-to-bottom. Only height that arrives after priming is animated.
          animatedH = nextPort.scrollHeight
          velocityPxPerSec = 0
          following = reportedLag <= FOLLOW_SLACK_PX
          maxShift = Number.POSITIVE_INFINITY
        } else {
          animatedH = Math.min(nextPort.scrollHeight, inherited.extent)
          velocityPxPerSec = inherited.velocityPxPerSec
          following = true
          const inheritedShift = currentShiftOf(shiftSurfacesOf(nextPort).at(-1) ?? nextPort)
          maxShift = inheritedShift > 0 ? inheritedShift : Number.POSITIVE_INFINITY
        }
        if (following) {
          hold(nextPort)
          if (isLeader(nextPort)) applyVisual(nextPort, animatedH, maxShift, velocityPxPerSec)
        }
        lastContentHeight = nextPort.scrollHeight
        primed = true
        return
      }

      if (!following && !interacting && reportedLag <= FOLLOW_SLACK_PX) {
        following = true
        animatedH = extent
        velocityPxPerSec = 0
        hold(nextPort)
      } else if (following && interacting && awayPx >= FOLLOW_UNPIN_GESTURE_PX) {
        following = false
        awayPx = 0
        handBackVisual(nextPort)
        animatedH = nextPort.scrollHeight
        velocityPxPerSec = 0
        drop(nextPort)
      }

      if (!activeRef.current || !following) return
      hold(nextPort)
      if (!isLeader(nextPort)) return

      // Runway and an equal transform cancel visually. It is the zero point,
      // not residual motion: decaying below it would scroll past the final
      // resting position and rebound when runway is removed.
      const lag = Math.max(0, nextPort.scrollHeight - animatedH - runwayOffsetOf(nextPort))
      const step = computeFollowStep(dt, {
        lag,
        speedEma: speedCpsRef.current,
        velocityPxPerSec,
      })
      if (lag <= 0.1) {
        animatedH = nextPort.scrollHeight - runwayOffsetOf(nextPort)
        velocityPxPerSec = 0
      } else {
        animatedH = Math.min(nextPort.scrollHeight, animatedH + step.advancePx)
        velocityPxPerSec = step.velocityPxPerSec
      }
      applyVisual(nextPort, animatedH, maxShift, velocityPxPerSec)
      lastContentHeight = nextPort.scrollHeight
    }

    rafId = requestAnimationFrame(frame)
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
      const preserveReader = interacting && awayPx >= FOLLOW_UNPIN_GESTURE_PX
      if (!following || !primed) {
        clearVisual(host)
        followLeaders.delete(host)
        return
      }
      if (preserveReader) {
        handBackVisual(host)
        clearVisual(host)
        followLeaders.delete(host)
        return
      }

      // Completion can land the final Tool/command height in this same
      // commit. Preserve the logical extent and drain it after unmount instead
      // of clearing the compositor state before the first settled paint.
      const finishGrowth = Math.max(0, host.scrollHeight - lastContentHeight)
      const finishShift = currentShiftOf(shiftSurfacesOf(host).at(-1) ?? host)
      const settleShiftCap = finishGrowth > 0 || finishShift <= 0
        ? Number.POSITIVE_INFINITY
        : finishShift
      settleAtFloor(host)
      applyVisual(host, animatedH, settleShiftCap, velocityPxPerSec)
      const runwayOffset = runwayOffsetOf(host)
      const remainingLag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
      if (remainingLag <= 0.1) {
        finishAtNaturalFloor(host)
        followLeaders.delete(host)
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
        if (interacting && awayPx >= FOLLOW_UNPIN_GESTURE_PX) {
          handBackVisual(host)
          clearVisual(host)
          followLeaders.delete(host)
          stopSettleListeners()
          return
        }
        const dt = Math.min(FOLLOW_MAX_FRAME_MS, Math.max(0, now - settleLast))
        settleLast = now
        const runwayOffset = runwayOffsetOf(host)
        const lag = Math.max(0, host.scrollHeight - animatedH - runwayOffset)
        if (lag <= 0.1) {
          animatedH = host.scrollHeight - runwayOffset
          velocityPxPerSec = 0
          finishAtNaturalFloor(host)
          followLeaders.delete(host)
          stopSettleListeners()
          return
        }
        const step = computeFollowStep(dt, {
          lag,
          speedEma: speedCpsRef.current,
          velocityPxPerSec,
        })
        animatedH = Math.min(host.scrollHeight, animatedH + step.advancePx)
        velocityPxPerSec = step.velocityPxPerSec
        settleAtFloor(host)
        applyVisual(host, animatedH, settleShiftCap, velocityPxPerSec)
        requestAnimationFrame(settleFrame)
      }
      requestAnimationFrame(settleFrame)
    }
  }, [active, rootRef, speedCpsRef])
}
