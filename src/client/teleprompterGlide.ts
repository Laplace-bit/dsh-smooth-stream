/**
 * Conversation-port follow while an assistant reply streams.
 *
 * The demo's damped-spring lerp is driven from a float `animatedTop`, never
 * from the rounded `scrollTop` the browser reports back. A wrap raises the
 * floor by a line; if the engine were allowed to snap `scrollTop` to that
 * floor, the previous line would hop up in one frame. This overlay:
 *
 * - owns follow via `data-follow-owned` so ChatView does not snap;
 * - sets `overflow-anchor: none` so CSS scroll-anchoring does not snap;
 * - restores `animatedTop` in a ResizeObserver (before paint) so a layout
 *   pass cannot flash a snapped frame;
 * - writes the interpolated lag as `translate3d` on `[data-chat-transcript]`
 *   (message rows only), so the turn-status chrome is not in that box.
 *
 * Handing the port back to the reader (unpin, or the owner going inactive)
 * first writes the effective visual top (`engine - lag`) into `scrollTop`
 * before clearing the transform, so the frame stays continuous. That write
 * also lands in ChatView's observed-top ledger as reader input beyond
 * `FOLLOW_THRESHOLD`, releasing its native snap-follow instead of fighting
 * the gesture for the port.
 *
 * Unpin is a real gesture (wheel / touch / pointer / key) that leaves the
 * floor; a `scrollTop` delta from our own write must not release the pin.
 */

import { useEffect, useRef, type RefObject } from 'react'

/**
 * Matches ChatView's `FOLLOW_OWNED_ATTR`. The overlay writes the last
 * programmatic `scrollTop` here so ChatView yields snap-follow and does not
 * treat the write as reader input.
 */
const FOLLOW_OWNED_ATTR = 'data-follow-owned'

/** Demo `1 - exp(-dt / 18)` time constant, in ms. */
export const FOLLOW_LERP_DT_MS = 18

/** Floor / ceiling of the per-frame lerp fraction before the dt term. */
export const FOLLOW_LERP_MIN = 0.05
export const FOLLOW_LERP_MAX = 0.25

/** Lag (px) at which the lag term of the lerp saturates. */
export const FOLLOW_LERP_LAG_REF_PX = 160

/** Reveal cps at which the speed factor is 1. */
export const FOLLOW_SPEED_REF_CPS = 35

export const FOLLOW_SPEED_FACTOR_MIN = 0.7
export const FOLLOW_SPEED_FACTOR_MAX = 2.2

/** Reader-return / still-pinned boundary, matching ChatView + the demo. */
export const FOLLOW_SLACK_PX = 25

/**
 * Upward wheel/touch distance that releases the pin. The engine `scrollTop`
 * is held on the floor while following, so a small trackpad tick never
 * appears as `reportedLag` and cannot be judged against {@link FOLLOW_SLACK_PX}.
 */
export const FOLLOW_UNPIN_GESTURE_PX = 8

/** How long a gesture keeps `isUserInteracting` so the next scroll can unpin. */
export const FOLLOW_GESTURE_MS = 800

const GESTURE_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const

export interface FollowGlideInput {
  /** How far the interpolated top trails the floor, in px. */
  readonly lag: number
  /** Observed reveal rate in chars/s; 0 uses {@link FOLLOW_SPEED_REF_CPS}. */
  readonly speedEma: number
}

export interface FollowGlideStep {
  /** Pixels to advance `animatedTop` this frame (fractional). */
  readonly advancePx: number
  /** Applied lerp fraction, for tests. */
  readonly lerpStep: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * One spring-lerp frame from the silky markdown demo.
 * @param dtMs - Frame delta in ms.
 * @param input - Current lag (from the float top, not the rounded engine top) and reveal-speed EMA.
 * @returns The fractional advance and the lerp fraction.
 */
export function computeFollowStep(dtMs: number, input: FollowGlideInput): FollowGlideStep {
  if (input.lag <= 0.1 || dtMs <= 0) return { advancePx: 0, lerpStep: 0 }
  const speed = input.speedEma > 0 ? input.speedEma : FOLLOW_SPEED_REF_CPS
  const speedFactor = clamp(speed / FOLLOW_SPEED_REF_CPS, FOLLOW_SPEED_FACTOR_MIN, FOLLOW_SPEED_FACTOR_MAX)
  const baseLerp = clamp((input.lag / FOLLOW_LERP_LAG_REF_PX) * speedFactor, FOLLOW_LERP_MIN, FOLLOW_LERP_MAX)
  const lerpStep = baseLerp * (1 - Math.exp(-dtMs / FOLLOW_LERP_DT_MS))
  return { advancePx: input.lag * lerpStep, lerpStep }
}

/** The message-rows box the lag transform rides on, when the host has one. */
function shiftRootOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector('[data-chat-transcript]')
}

/**
 * Row wrappers that carry only messages/tools. Hosts without a transcript
 * box keep the turn-status chrome as a sibling of the rows inside
 * `[data-chat-flow]`, so shifting that whole flow would drag the chrome
 * along; shifting the rows individually leaves every non-message sibling
 * (turn status, steering bubbles) pinned while the text glides.
 */
function shiftRowsOf(port: HTMLElement): HTMLElement[] {
  return [...port.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')]
}

/** Element whose resize signals flow growth for the before-paint restore. */
function resizeProxyOf(port: HTMLElement): HTMLElement | null {
  return port.querySelector('[data-chat-transcript]') ?? port.querySelector('[data-chat-flow]')
}

/** True when the glide expresses its lag as transforms instead of engine top. */
function hasShiftSurface(port: HTMLElement): boolean {
  return shiftRootOf(port) !== null || shiftRowsOf(port).length > 0
}

function setShift(element: HTMLElement, px: number): void {
  if (Math.abs(px) > 0.01) {
    element.style.transform = `translate3d(0, ${px}px, 0)`
    element.style.willChange = 'transform'
  } else {
    element.style.transform = ''
    element.style.willChange = ''
  }
}

/**
 * While following: pin the engine at the floor so ChatView's to-bottom
 * chrome stays hidden (`FOLLOW_THRESHOLD` is 24px), and put the interpolated
 * lag on transforms - on `[data-chat-transcript]` (message rows only) when
 * the host has that box, else on each `[data-chat-anchor-key]` row so the
 * turn-status chrome (their sibling) never rides the motion. Without any
 * shift surface the engine itself carries the interpolated top.
 */
function applyVisual(port: HTMLElement, animatedTop: number): void {
  const floor = Math.max(0, port.scrollHeight - port.clientHeight)
  const top = Math.min(floor, Math.max(0, animatedTop))
  const lag = floor - top
  port.style.overflowAnchor = 'none'
  port.style.scrollBehavior = 'auto'
  const shiftRoot = shiftRootOf(port)
  if (shiftRoot !== null) {
    port.scrollTop = floor
    port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
    setShift(shiftRoot, lag)
    return
  }
  const rows = shiftRowsOf(port)
  if (rows.length > 0) {
    port.scrollTop = floor
    port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
    for (const row of rows) setShift(row, lag)
    return
  }
  port.scrollTop = top
  port.setAttribute(FOLLOW_OWNED_ATTR, String(port.scrollTop))
}

function clearVisual(port: HTMLElement): void {
  port.removeAttribute(FOLLOW_OWNED_ATTR)
  port.style.overflowAnchor = ''
  port.style.scrollBehavior = ''
  const shiftRoot = shiftRootOf(port)
  if (shiftRoot !== null) {
    shiftRoot.style.transform = ''
    shiftRoot.style.willChange = ''
    return
  }
  for (const row of shiftRowsOf(port)) {
    row.style.transform = ''
    row.style.willChange = ''
  }
}

/** Live follow hosts per conversation port so one unmount does not clear another. */
const followOwners = new WeakMap<HTMLElement, number>()

function acquireFollow(port: HTMLElement): void {
  followOwners.set(port, (followOwners.get(port) ?? 0) + 1)
}

function releaseFollow(port: HTMLElement): number {
  const next = (followOwners.get(port) ?? 1) - 1
  if (next <= 0) {
    followOwners.delete(port)
    return 0
  }
  followOwners.set(port, next)
  return next
}

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

  useEffect(() => {
    if (!active) return
    let rafId = 0
    let last = performance.now()
    let following = true
    let primed = false
    let animatedTop = 0
    let interacting = false
    let interactTimer: ReturnType<typeof setTimeout> | null = null
    let port: HTMLElement | null = null
    let resize: ResizeObserver | null = null
    let holding: HTMLElement | null = null
    let awayPx = 0

    const hold = (next: HTMLElement): void => {
      if (holding === next) return
      if (holding !== null) releaseFollow(holding)
      acquireFollow(next)
      holding = next
    }

    const drop = (next: HTMLElement): void => {
      if (holding === next) {
        releaseFollow(next)
        holding = null
      }
      clearVisual(next)
    }

    /**
     * Give the reader the visual position the glide was showing before the
     * transforms go away. While transforms carry the lag, the engine sits at
     * the floor and the effective visual top is `engine - lag`; writing that
     * keeps the handover frame-continuous, and the write shows up in
     * ChatView's ledger as reader movement, disarming its snap-follow.
     * Without a shift surface the engine already holds the interpolated top,
     * so there is nothing to compensate.
     */
    const handBackVisual = (next: HTMLElement): void => {
      if (!hasShiftSurface(next)) return
      const floor = Math.max(0, next.scrollHeight - next.clientHeight)
      const lag = Math.max(0, floor - animatedTop)
      next.scrollTop = Math.min(floor, Math.max(0, next.scrollTop - lag))
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
      if (!following || port === null) return
      const floor = Math.max(0, port.scrollHeight - port.clientHeight)
      applyVisual(port, Math.min(floor, animatedTop))
    }

    const bindPort = (next: HTMLElement): void => {
      if (port === next) return
      if (port !== null) {
        for (const name of GESTURE_EVENTS) port.removeEventListener(name, markGesture)
        resize?.disconnect()
      }
      port = next
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
      const dt = Math.min(50, now - last)
      last = now
      const root = rootRef.current
      if (root === null) return
      const nextPort = root.closest<HTMLElement>('[data-conversation-scroll]')
      if (nextPort === null) return
      bindPort(nextPort)

      const floor = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight)
      const reportedLag = floor - nextPort.scrollTop

      if (!primed) {
        animatedTop = nextPort.scrollTop
        following = reportedLag <= FOLLOW_SLACK_PX
        if (following) {
          hold(nextPort)
          applyVisual(nextPort, animatedTop)
        }
        primed = true
        return
      }

      if (!following && !interacting && reportedLag <= FOLLOW_SLACK_PX) {
        following = true
        animatedTop = nextPort.scrollTop
        hold(nextPort)
      } else if (following && interacting && awayPx >= FOLLOW_UNPIN_GESTURE_PX) {
        following = false
        awayPx = 0
        // Compensate before the transform clears, or the flow (turn-status
        // chrome included) jumps up by the whole lag in one frame.
        handBackVisual(nextPort)
        animatedTop = nextPort.scrollTop
        drop(nextPort)
      }

      if (!activeRef.current || !following) return
      hold(nextPort)

      const lag = floor - animatedTop
      const step = computeFollowStep(dt, {
        lag,
        speedEma: speedCpsRef.current,
      })
      if (lag <= 0.1) {
        animatedTop = floor
      } else {
        animatedTop = Math.min(floor, animatedTop + step.advancePx)
      }
      applyVisual(nextPort, animatedTop)
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
      if (following) {
        // Same handback as an unpin: land on the effective visual top rather
        // than the floor, so the owner change (stream close, unmount) does
        // not snap the flow up by the remaining lag.
        handBackVisual(host)
      }
      const remaining = holding === host ? releaseFollow(host) : (followOwners.get(host) ?? 0)
      holding = null
      if (remaining === 0) clearVisual(host)
    }
  }, [active, rootRef, speedCpsRef])
}
