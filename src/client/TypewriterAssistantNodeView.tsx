import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from 'react'
import type { ImageLoader, MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import { ImageGallery, JsonBlock, MarkdownText } from './primitives-compat.tsx'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import { IconThink } from './harnessIcons.ts'
import {
  notifyFollowCommit,
  FollowRevealPhaseTracker,
  computeFollowTrajectoryStep,
} from './teleprompterGlide.ts'
import { useSmoothStreamContent, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { useFpsGuard } from './useFpsGuard.ts'
import { useLogarithmicFade } from './useLogarithmicFade.ts'
import { useDecoupledMarkdown } from './useDecoupledMarkdown.ts'
import { FollowHost } from './FollowHost.tsx'
import { DEFAULT_STREAM_CONFIG, type StreamMode } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS, type StreamMotionPreference } from '../settings.ts'
import { belongsToFlowPart, isFlowPartActiveTail, type AssistantStepPart } from './flowPart.ts'
import css from './TypewriterAssistantNodeView.module.css'

type AssistantProps = ChatNodeViewProps<'assistant-step'>

type MarkdownProps = Pick<ComponentProps<typeof MarkdownText>, 'labels' | 'fileMentions' | 'text'>

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia === undefined) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/**
 * Resolve whether the reveal engine should stay off for this view. The OS
 * preference wins only in `auto` mode: `force-smooth` keeps the engine on
 * machines where a system-wide reduce-motion switch (or a forced browser
 * flag) would otherwise silently bypass smoothing, and `force-reduced`
 * disables it even when the OS asks for motion. Credit: three-state design
 * proposed by @Zn-Dk in #21/#22.
 */
function useMotionReduced(preference: StreamMotionPreference): boolean {
  const system = usePrefersReducedMotion()
  if (preference === 'force-smooth') return false
  if (preference === 'force-reduced') return true
  return system
}

interface AnimatedMarkdownTextProps extends MarkdownProps {
  streaming: boolean
  logarithmicFade: boolean
  /** Whether the resolved reduced-motion gate keeps the reveal engine off. */
  motionReduced: boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealedCharsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  onPredictiveChange?: ((predictive: boolean) => void) | undefined
  /** Reports whether the final text arm still has visible reveal work. */
  onRevealActivityChange?: ((active: boolean) => void) | undefined
  preset: StreamSmoothingPreset
  shouldHoldBack: () => boolean
}

/** Conservative fallback before the streaming Markdown tail has geometry. */
const PREDICTIVE_WRAP_FALLBACK_CHARS = 32
const STREAM_ANNOUNCEMENT_INTERVAL_MS = 800
const STREAM_ANNOUNCEMENT_MAX_CHARS = 320

interface PendingTextGeometry {
  root: HTMLElement
  visibleText: string
  fontSize: number
  wrapThresholdWidth: number | null
}

function approximateInlineWidth(text: string, emPx: number): number {
  let width = 0
  for (const char of text) {
    if (/\s/u.test(char)) width += emPx * 0.33
    else if (/^[\x00-\x7f]$/u.test(char)) width += emPx * 0.56
    else width += emPx
  }
  return width
}


/** Whether buffered source can reach a new visual line before it drains. */
function pendingTextCanGrow(
  root: HTMLElement | null,
  visibleText: string,
  pending: string,
  geometryRef: { current: PendingTextGeometry | null },
): boolean {
  if (pending === '') return false
  if (/[\r\n]/u.test(pending)) return true
  const pendingChars = [...pending]
  if (pendingChars.length >= PREDICTIVE_WRAP_FALLBACK_CHARS) return true
  if (root === null) return false

  let geometry = geometryRef.current
  if (geometry?.root !== root) {
    const rootWidth = root.clientWidth || 600
    geometry = { root, visibleText, fontSize: 14, wrapThresholdWidth: Math.max(120, rootWidth * 0.4) }
    geometryRef.current = geometry
  }
  return approximateInlineWidth(pending, geometry.fontSize) >= (geometry.wrapThresholdWidth ?? (geometry.fontSize * PREDICTIVE_WRAP_FALLBACK_CHARS))
}

function announcementChunkEnd(source: string, start: number): number {
  const hardEnd = Math.min(source.length, start + STREAM_ANNOUNCEMENT_MAX_CHARS)
  if (hardEnd === source.length) return hardEnd
  const softStart = start + Math.floor(STREAM_ANNOUNCEMENT_MAX_CHARS * 0.6)
  for (let index = hardEnd - 1; index >= softStart; index -= 1) {
    if (/[\s.,;:!?]/u.test(source[index] ?? '')) return index + 1
  }
  return hardEnd
}

/** Pace screen-reader updates independently from visual reveal frames. */
interface StreamAnnouncementState {
  text: string
  revision: number
  present: boolean
}

/** A commit-driven live region isolated from the visible Markdown subtree. */
const StreamAnnouncement = memo(function StreamAnnouncement({
  text,
  active,
}: {
  text: string
  active: boolean
}) {
  const [announcement, setAnnouncement] = useState<StreamAnnouncementState>({
    text: '',
    revision: 0,
    present: active,
  })
  const sourceRef = useRef(text)
  const activeRef = useRef(active)
  const announcedOffsetRef = useRef(active ? 0 : text.length)
  const drainSourceRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearTimer = (): void => {
      if (timerRef.current === null) return
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const publishNext = (source: string): boolean => {
      const start = Math.min(announcedOffsetRef.current, source.length)
      const end = announcementChunkEnd(source, start)
      if (end <= start) return false
      announcedOffsetRef.current = end
      setAnnouncement(previous => ({
        text: source.slice(start, end),
        revision: previous.revision + 1,
        present: true,
      }))
      return end < source.length
    }

    const hideAfterLinger = (): void => {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (activeRef.current) return
        drainSourceRef.current = null
        setAnnouncement(previous => ({ ...previous, present: false }))
      }, STREAM_ANNOUNCEMENT_INTERVAL_MS)
    }

    const drainNext = (): void => {
      const source = drainSourceRef.current
      if (source === null) return
      if (!publishNext(source)) {
        hideAfterLinger()
        return
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (activeRef.current) return
        drainNext()
      }, STREAM_ANNOUNCEMENT_INTERVAL_MS)
    }

    const scheduleLive = (): void => {
      if (timerRef.current !== null || announcedOffsetRef.current >= sourceRef.current.length) return
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (!activeRef.current) return
        const source = sourceRef.current
        if (publishNext(source)) scheduleLive()
      }, STREAM_ANNOUNCEMENT_INTERVAL_MS)
    }

    const wasActive = activeRef.current
    const previousSource = sourceRef.current
    const continuingDrain = !active && !wasActive && drainSourceRef.current !== null
    if (
      !continuingDrain
      && (!text.startsWith(previousSource) || announcedOffsetRef.current > text.length)
    ) {
      announcedOffsetRef.current = 0
    }
    sourceRef.current = text
    activeRef.current = active

    if (active) {
      if (!wasActive) {
        clearTimer()
        drainSourceRef.current = null
        setAnnouncement(previous => ({
          text: '',
          revision: previous.revision + 1,
          present: true,
        }))
      }
      scheduleLive()
      return
    }

    if (!wasActive) {
      if (drainSourceRef.current === null) announcedOffsetRef.current = text.length
      return
    }

    clearTimer()
    drainSourceRef.current = text
    drainNext()
  }, [active, text])

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  if (!active && !announcement.present) return null
  const activating = active && !activeRef.current
  return (
    <span
      className={css.visuallyHidden}
      aria-live="polite"
      aria-atomic="true"
    >
      <span key={announcement.revision}>{activating ? '' : announcement.text}</span>
    </span>
  )
})

/**
 * Smooth streaming text arm. While the reply runs, the accumulated source is
 * revealed through the smoother at a rate that tracks the model's arrival
 * and rendered by the Harness `MarkdownText`
 * streaming arm (incremental parse, frozen non-tail blocks), so there is no
 * raw-text tail and no text-to-markdown swap: the tree stays markdown
 * throughout. The outer assistant owner follows all text growth, including
 * the final drain, so wraps glide without a completion handoff. Once the
 * queue drains, the settled full parse (KaTeX math, fence highlighting, file
 * mentions) swaps in exactly once.
 */
function AnimatedMarkdownText({
  text,
  labels,
  fileMentions,
  streaming,
  logarithmicFade,
  motionReduced,
  followSpeedCpsRef,
  followRevealedCharsRef,
  followRevealScaleRef,
  onPredictiveChange,
  onRevealActivityChange,
  preset,
  shouldHoldBack,
}: AnimatedMarkdownTextProps) {
  const reduced = motionReduced
  const [typing, setTyping] = useState(streaming)
  const localSpeedCpsRef = useRef(35)
  const followRootRef = useRef<HTMLDivElement>(null)
  const predictionSourceRef = useRef<string | null>(null)
  const predictionStateRef = useRef(false)
  const predictionGeometryRef = useRef<PendingTextGeometry | null>(null)
  const speedCpsRef = followSpeedCpsRef ?? localSpeedCpsRef
  const displayed = useSmoothStreamContent(text, {
    enabled: typing && !reduced,
    inputComplete: !streaming,
    preset,
    shouldHoldBack,
    speedCpsRef,
    revealedCharsRef: followRevealedCharsRef,
    revealScaleRef: followRevealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(followRootRef.current) },
  })
  const shown = reduced ? text : displayed
  const live = typing && !reduced
  const markdownShown = useDecoupledMarkdown(shown, live)
  useLogarithmicFade(followRootRef, logarithmicFade && !reduced, live, speedCpsRef)

  useEffect(() => {
    const root = followRootRef.current
    if (root === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (predictionGeometryRef.current?.root === root) predictionGeometryRef.current = null
    })
    observer.observe(root)
    return () => { observer.disconnect() }
  }, [])

  useLayoutEffect(() => {
    if (onPredictiveChange === undefined) return
    const pending = text.slice(shown.length)
    const sourceChanged = predictionSourceRef.current !== text
    const next = !live || !streaming || pending === ''
      ? false
      : sourceChanged
        ? pendingTextCanGrow(followRootRef.current, shown, pending, predictionGeometryRef)
        : predictionStateRef.current
    predictionSourceRef.current = text
    predictionStateRef.current = next
    onPredictiveChange(next)
  }, [live, onPredictiveChange, shown, streaming, text])

  useLayoutEffect(() => {
    onRevealActivityChange?.(live)
  }, [live, onRevealActivityChange])

  // The stream closed: keep revealing the remaining queue, then swap to the
  // settled parse exactly once. The markdown tree stays mounted until then.
  useEffect(() => {
    if (typing && !streaming && shown.length === text.length) setTyping(false)
  }, [shown, streaming, text, typing])

  // A row can mount before the projection flips its assistant step to
  // `running`, which would freeze `typing` at false forever and leave the
  // reveal engine off for the whole reply. Re-arm on the rising edge so late
  // stream starts are still smoothed. (Adopted from #22 by @Zn-Dk.)
  useEffect(() => {
    if (streaming) setTyping(true)
  }, [streaming])

  if (!streaming && !live && text.trim() === '') return null

  return (
    <div ref={followRootRef} className={css.follow} data-follow-text="">
      <MarkdownText
        // `shown` stays authoritative through the completion drain: the
        // settled parse swaps in only when the queue has actually emptied.
        // Rendering `text` early bypasses the drain and teleports the tail.
        text={live ? markdownShown : text}
        streaming={live}
        labels={labels}
        fileMentions={live ? undefined : fileMentions}
      />
    </div>
  )
}

function imageLabels(t: AssistantProps['t']): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: {
      dialog: t('image.preview'),
      close: t('image.closePreview'),
    },
  }
}

/**
 * Apply searchable hidden state without unmounting a stable subtree — the
 * Host's completion fold hides the answer-inline reasoning this way, so the
 * takeover renderer must reproduce it to stay inside the contract: the row
 * disappears into the Host's process summary and comes back on find-in-page.
 * (Mirrors the Harness chat kit's `useSearchableHidden`.)
 */
function useSearchableHidden(
  hidden: boolean,
  reveal: () => void,
): RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    if (hidden && element.contains(element.ownerDocument.activeElement)) {
      reveal()
      return
    }
    if (hidden) element.setAttribute('hidden', 'until-found')
    else element.removeAttribute('hidden')
  }, [hidden, reveal])
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.addEventListener('beforematch', reveal)
    return () => { element.removeEventListener('beforematch', reveal) }
  }, [reveal])
  return ref
}

/**
 * One answer-inline reasoning block wrapped in the Host's fold contract. The
 * Host computes the fold decision (turn closed, compact transcript, this node
 * is the answer) and delivers it through the `turnProcess` owner prop; when
 * folded the block hides into the Host's "thought" summary row instead of
 * staying mounted above the answer.
 */
function FoldableReasoning({
  hidden,
  reveal,
  children,
}: {
  hidden: boolean
  reveal: () => void
  children: ReactNode
}) {
  const ref = useSearchableHidden(hidden, reveal)
  return (
    <div ref={ref} data-turn-process-inline={hidden || undefined}>
      {children}
    </div>
  )
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Built-in Think disclosure with a smoothed `text` feed. Chevron and row
 * click stay on the disclosure chrome, which the plugin's AnimatedDisclosure
 * renders with a height-animated body (the harness primitive would mount and
 * unmount it, which cannot glide). The row opens only while this block is
 * the streaming tail and closes as soon as thinking ends — a later block,
 * or the assistant node settling — not when the rest of the reply is
 * still streaming.
 */
function AnimatedReasoning({
  text,
  running,
  preset,
  thinkAutoExpand,
  motionReduced,
  logarithmicFade,
  shouldHoldBack,
  followSpeedCpsRef,
  followRevealScaleRef,
  followRevealedCharsRef,
  onPredictiveChange,
  t,
}: {
  text: string
  running: boolean
  preset: StreamSmoothingPreset
  thinkAutoExpand: boolean
  motionReduced: boolean
  logarithmicFade: boolean
  shouldHoldBack: () => boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  followRevealedCharsRef?: { current: number } | undefined
  onPredictiveChange?: ((predictive: boolean) => void) | undefined
  t: AssistantProps['t']
}) {
  const reduced = motionReduced
  const [expanded, setExpanded] = useState(running && thinkAutoExpand)
  const [autoClosed, setAutoClosed] = useState(false)

  useEffect(() => {
    onPredictiveChange?.(running && expanded)
  }, [running, expanded, onPredictiveChange])
  const summaryRef = useRef<HTMLSpanElement>(null)
  const fadeRootRef = useRef<HTMLDivElement>(null)
  // The custom thinking auto-scroll drives the SAME node as the logarithmic
  // fade, so it reuses that ref object rather than installing a second one
  // (a callback ref would re-attach on every render).
  const thinkBodyRef = fadeRootRef
  const localFadeSpeedRef = useRef(35)
  const fadeSpeedRef = followSpeedCpsRef ?? localFadeSpeedRef
  const localRevealedCharsRef = useRef(0)
  const revealedCharsRef = followRevealedCharsRef ?? localRevealedCharsRef
  const userScrolledRef = useRef(false)
  const rafIdRef = useRef(0)
  // Latest "the live stream still owns this scroller" state. Tracked on every
  // render so the queued frame can re-read it: a stop or a collapse landing
  // between scheduling and the frame must not move the viewport.
  const followActiveRef = useRef(false)
  followActiveRef.current = running && expanded
  const commitAnchorRef = useRef<HTMLDivElement>(null)
  // The running→false flip is the AUTO-close: it collapses instantly and the
  // follower's settle spring absorbs the height step. A later manual toggle
  // keeps the CSS glide.
  const displayed = useSmoothStreamContent(text, {
    enabled: running && !reduced,
    preset,
    shouldHoldBack,
    speedCpsRef: fadeSpeedRef,
    revealScaleRef: followRevealScaleRef,
    revealedCharsRef,
    onRevealCommit: () => { notifyFollowCommit(commitAnchorRef.current) },
  })
  const shown = running && !reduced ? displayed : text
  const summary = running ? latestLine(shown) : firstLine(text)
  useLogarithmicFade(fadeRootRef, logarithmicFade && !reduced && expanded, running, fadeSpeedRef)

  useLayoutEffect(() => {
    // Only the running state owns disclosure while auto-expand is on; with it
    // off, a manual toggle is never wrestled back by the stream.
    if (thinkAutoExpand) {
      setExpanded(running)
      setAutoClosed(!running)
    }
    if (running) {
      userScrolledRef.current = false
    }
    // A commit that changes this block's height must hand the follower its
    // correction in the SAME task, before the grown-but-uncompensated frame
    // can reach a paint.
    notifyFollowCommit(commitAnchorRef.current)
  }, [running, thinkAutoExpand])

  const phaseTrackerRef = useRef<FollowRevealPhaseTracker | null>(null)
  if (phaseTrackerRef.current === null) {
    phaseTrackerRef.current = new FollowRevealPhaseTracker({
      seedCharsPerLine: 35,
      seedLineHeightPx: 24,
    })
  }

  const thinkRunwayRef = useRef<HTMLDivElement>(null)
  const currentRunwayHeightRef = useRef(0)
  const trajectoryPositionRef = useRef<number | null>(null)
  const trajectoryVelocityRef = useRef(0)
  const lastGlideTimeRef = useRef(0)
  const isGlidingRef = useRef(false)

  const RUNWAY_BASE_PX = 16

  const stepGlide = useCallback(() => {
    rafIdRef.current = 0
    const el = thinkBodyRef.current
    if (!followActiveRef.current || userScrolledRef.current || el === null) {
      isGlidingRef.current = false
      lastGlideTimeRef.current = 0
      trajectoryPositionRef.current = null
      trajectoryVelocityRef.current = 0
      if (thinkRunwayRef.current !== null && currentRunwayHeightRef.current !== 0) {
        currentRunwayHeightRef.current = 0
        thinkRunwayRef.current.style.height = '0px'
      }
      return
    }

    const now = performance.now()
    const dt = lastGlideTimeRef.current > 0 ? Math.min(32, Math.max(1, now - lastGlideTimeRef.current)) : 16.7
    lastGlideTimeRef.current = now

    // Measure the raw text floor by deducting the currently applied dynamic runway
    const measuredScrollExtent = Math.max(0, el.scrollHeight - el.clientHeight)
    const textFloor = Math.max(0, measuredScrollExtent - currentRunwayHeightRef.current)

    if (textFloor <= 0 && measuredScrollExtent <= 0) {
      el.scrollTop = 0
      trajectoryPositionRef.current = 0
      trajectoryVelocityRef.current = 0
      if (thinkRunwayRef.current !== null && currentRunwayHeightRef.current !== 0) {
        currentRunwayHeightRef.current = 0
        thinkRunwayRef.current.style.height = '0px'
      }
      if (running && expanded) {
        isGlidingRef.current = true
        rafIdRef.current = requestAnimationFrame(stepGlide)
      } else {
        isGlidingRef.current = false
      }
      return
    }

    // Phase progression tracking: advances smoothly per revealed character
    const charCount = revealedCharsRef.current || shown.length
    const phase = phaseTrackerRef.current!.advance(textFloor, charCount)
    const lineHeight = phase.lineHeightPx || 24

    // JITTER-FREE RUNWAY COMPENSATOR:
    // When text wraps to a new line, DOM scrollHeight increases by lineHeight (~24px).
    // By growing the runway by (phase * lineHeight) during character reveal and resetting
    // it on wrap, the combined (textHeight + runwayHeight) stays perfectly continuous across
    // wrap boundaries with ZERO jump in the denominator (scrollHeight - clientHeight).
    // This completely eliminates the sawtooth oscillation of the scrollbar thumb.
    const dynamicRunway = running && expanded ? RUNWAY_BASE_PX + phase.phase * lineHeight : 0
    if (thinkRunwayRef.current !== null && Math.abs(currentRunwayHeightRef.current - dynamicRunway) >= 0.25) {
      currentRunwayHeightRef.current = dynamicRunway
      thinkRunwayRef.current.style.height = `${dynamicRunway}px`
    }

    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight)
    if (reduced) {
      el.scrollTop = maxScroll
      trajectoryPositionRef.current = maxScroll
      isGlidingRef.current = false
      return
    }

    const targetPx = Math.min(maxScroll, phase.targetPx)

    if (trajectoryPositionRef.current === null || Math.abs(trajectoryPositionRef.current - el.scrollTop) > 3) {
      trajectoryPositionRef.current = el.scrollTop
    }
    const currentPos = trajectoryPositionRef.current
    const cps = fadeSpeedRef.current || 35
    const targetVelocityPxPerMs = Math.max(0, cps) * (lineHeight / Math.max(10, phase.charsPerLine)) / 1000

    const trajectoryStep = computeFollowTrajectoryStep(dt, {
      positionPx: currentPos,
      velocityPxPerMs: trajectoryVelocityRef.current,
      targetPx,
      targetVelocityPxPerMs,
      minLagPx: 1,
      maxLagPx: 24,
      paintFloorPx: maxScroll,
    })

    trajectoryPositionRef.current = trajectoryStep.positionPx
    trajectoryVelocityRef.current = trajectoryStep.velocityPxPerMs
    el.scrollTop = trajectoryStep.positionPx

    if (running && expanded && !userScrolledRef.current) {
      isGlidingRef.current = true
      rafIdRef.current = requestAnimationFrame(stepGlide)
    } else if (targetPx - trajectoryStep.positionPx > 0.5) {
      isGlidingRef.current = true
      rafIdRef.current = requestAnimationFrame(stepGlide)
    } else {
      isGlidingRef.current = false
      lastGlideTimeRef.current = 0
    }
  }, [reduced, running, expanded, shown, fadeSpeedRef, revealedCharsRef])

  useEffect(() => {
    // Only the live stream owns the reading position. A settled block is
    // something to read from the top, so expanding a finished reasoning card
    // must not scroll it — that would make its first lines unreachable.
    if (!running || !expanded || userScrolledRef.current) return
    const el = thinkBodyRef.current
    if (el === null) return
    if (!isGlidingRef.current) {
      isGlidingRef.current = true
      lastGlideTimeRef.current = performance.now()
      rafIdRef.current = requestAnimationFrame(stepGlide)
    }
  }, [running, expanded, shown, stepGlide])

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== 0) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = 0
      }
      isGlidingRef.current = false
      lastGlideTimeRef.current = 0
      trajectoryPositionRef.current = null
      trajectoryVelocityRef.current = 0
      if (thinkRunwayRef.current !== null && currentRunwayHeightRef.current !== 0) {
        currentRunwayHeightRef.current = 0
        thinkRunwayRef.current.style.height = '0px'
      }
    }
  }, [])

  useEffect(() => {
    if (!running) {
      if (thinkRunwayRef.current !== null && currentRunwayHeightRef.current !== 0) {
        currentRunwayHeightRef.current = 0
        thinkRunwayRef.current.style.height = '0px'
      }
    }
  }, [running])

  useEffect(() => {
    const el = thinkBodyRef.current
    if (el === null) return
    let isPointerDown = false
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        userScrolledRef.current = true
        if (rafIdRef.current !== 0) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = 0
        }
        isGlidingRef.current = false
        lastGlideTimeRef.current = 0
        trajectoryPositionRef.current = el.scrollTop
        trajectoryVelocityRef.current = 0
      } else if (e.deltaY > 0) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 30) {
          userScrolledRef.current = false
          trajectoryPositionRef.current = el.scrollTop
        }
      }
    }
    const onPointerDown = () => {
      isPointerDown = true
    }
    const onPointerUp = () => {
      isPointerDown = false
    }
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 30
      if (atBottom) {
        userScrolledRef.current = false
      } else if (isPointerDown) {
        userScrolledRef.current = true
        trajectoryVelocityRef.current = 0
      }
      trajectoryPositionRef.current = el.scrollTop
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('pointerdown', onPointerDown, { passive: true })
    window.addEventListener('pointerup', onPointerUp, { passive: true })
    window.addEventListener('pointercancel', onPointerUp, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      el.removeEventListener('scroll', onScroll)
    }
  }, [])

  useEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  }, [running, summary])

  // Preserve FollowHost's layout wrapper without mounting a second scroll owner.
  return (
    <div className={css.follow} ref={commitAnchorRef}>
      <div className={css.think} data-variant="think" data-state={running ? 'running' : 'ok'}>
        {running && <span className={css.visuallyHidden}>{t('row.running')}</span>}
        <AnimatedDisclosure
          rowClassName={css.thinkRow}
          leadingClassName={css.thinkLeading}
          titleClassName={css.thinkTitle}
          chevronClassName={css.thinkChevron}
          icon={<IconThink size={14} />}
          // `message.think` is not in the `conversation` key union this prop is
          // typed with: no Harness version owns it there. On 0.1.5+ it lives in
          // the `chat` namespace, and on older builds only this plugin's own
          // fallback dictionary has it. The layered lookup installed in
          // index.ts resolves it either way, so the cast widens the key domain
          // rather than skipping a lookup. No hardcoded label and no
          // `<html lang>` sniffing: a key that resolves nowhere shows the key,
          // which the locale routing test catches.
          title={(t as unknown as (key: string) => string)('message.think')}
          open={expanded}
          onToggle={() => {
            setAutoClosed(false)
            setExpanded(value => !value)
          }}
          // The auto-close at stream end snaps (no grid-track animation): the
          // follower's settle spring absorbs the height step through the
          // compositor, so animating the track too would double-animate the
          // collapse. Manual toggles while streaming keep the glide.
          bodyTransition={!autoClosed}
          collapsedContent={(
            <>
              <span className={css.thinkSeparator} aria-hidden />
              <span ref={summaryRef} className={css.thinkSummary} data-follow-end={running || undefined}>{summary}</span>
            </>
          )}
        >
          <div ref={fadeRootRef} className={css.thinkBody}>
            {shown}
            <div
              ref={thinkRunwayRef}
              aria-hidden="true"
              style={{
                height: 0,
                minHeight: 0,
                flexShrink: 0,
                pointerEvents: 'none',
              }}
            />
          </div>
        </AnimatedDisclosure>
      </div>
    </div>
  )
}

/**
 * Assistant node renderer for the typewriter overlay. Text observed while
 * streaming is revealed by the smoother through the Harness Markdown
 * renderer at a rate that tracks arrival. Reasoning blocks keep the
 * built-in Think disclosure and only receive a smoothed text feed; the
 * outer node owns conversation-port follow through both streaming and the
 * final text drain. Keeping one owner avoids a lifecycle handoff that would
 * reopen and later retire a second runway. The FPS guard holds offscreen
 * reveals when the frame rate is degraded. Settled text renders with the full
 * Markdown pipeline.
 */
export const TypewriterAssistantNodeView = memo(function TypewriterAssistantNodeView({
  mode: _mode = DEFAULT_STREAM_CONFIG.mode,
  preset = DEFAULT_STREAM_CONFIG.preset,
  revealCharsPerSec: _revealCharsPerSec = DEFAULT_STREAM_CONFIG.revealCharsPerSec,
  scrollSpeedPxPerSec: _scrollSpeedPxPerSec = DEFAULT_STREAM_CONFIG.scrollSpeedPxPerSec,
  maxScrollSpeedPxPerSec: _maxScrollSpeedPxPerSec = DEFAULT_STREAM_CONFIG.maxScrollSpeedPxPerSec,
  thinkAutoExpand = DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
  logarithmicFade = DEFAULT_STREAM_SETTINGS.logarithmicFade,
  controlScroll = true,
  motionPreference = DEFAULT_STREAM_SETTINGS.motionPreference,
  groupPart,
  node,
  useTurnData,
  openFile,
  loadImage,
  fileMentions,
  turnProcess,
  t,
}: AssistantProps & {
  mode?: StreamMode
  preset?: StreamSmoothingPreset
  revealCharsPerSec?: number
  scrollSpeedPxPerSec?: number
  maxScrollSpeedPxPerSec?: number
  thinkAutoExpand?: boolean
  logarithmicFade?: boolean
  controlScroll?: boolean
  motionPreference?: StreamMotionPreference
  /**
   * Flow part this render owns; absent on kernels that render a step once.
   *
   * Declared with an explicit `undefined` because the seat passes the field
   * through unvalidated: `index.ts` narrows it structurally off older seat
   * props, and `exactOptionalPropertyTypes` rejects handing an absent key an
   * `undefined` value.
   */
  groupPart?: AssistantStepPart | undefined
}) {
  const data = node.data
  const streaming = data.status === 'running'
  const reduced = useMotionReduced(motionPreference)
  // The Host's completion-fold decision for THIS node's inline reasoning:
  // only the answer step folds, only in compact-transcript mode, and only
  // once the turn has closed (foldable implies it). Mirrors the built-in
  // assistant renderer so the takeover keeps the official behavior.
  const reasoningHidden = turnProcess !== undefined
    && turnProcess.foldable
    && turnProcess.spec.answerStep === data.step
    && turnProcess.spec.inlineReasoning
    && !turnProcess.open
  const revealProcess = useCallback(() => { turnProcess?.setOpen(true) }, [turnProcess])
  const belongsToPart = (block: (typeof data.blocks)[number]): boolean => belongsToFlowPart(block, groupPart)
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  const rootSpeedRef = useRef(35)
  const rootRevealedCharsRef = useRef(0)
  const rootRevealScaleRef = useRef(1)
  const previousStreamingRef = useRef(streaming)
  const [textRevealActive, setTextRevealActive] = useState(false)
  const completionCandidate = !streaming
    && previousStreamingRef.current
    && data.blocks.some(block => belongsToPart(block) && block.kind === 'text' && block.text.trim() !== '')
  useLayoutEffect(() => {
    previousStreamingRef.current = streaming
  }, [streaming])
  const updateTextRevealActivity = useCallback((active: boolean): void => {
    setTextRevealActive(previous => previous === active ? previous : active)
  }, [])
  /** Last block this render owns; `blocks.length - 1` on kernels without parts. */
  let lastPartIndex = -1
  for (let index = data.blocks.length - 1; index >= 0; index -= 1) {
    const block = data.blocks[index]
    if (block !== undefined && belongsToPart(block)) {
      lastPartIndex = index
      break
    }
  }
  const reasoningTailIndex = streaming && lastPartIndex !== -1 && data.blocks[lastPartIndex]?.kind === 'reasoning'
    ? lastPartIndex
    : -1
  const reasoningOwnsSpeed = reasoningTailIndex !== -1
  const rootPredictiveRef = useRef(false)
  if (reasoningOwnsSpeed) {
    rootPredictiveRef.current = true
  }
  const previousReasoningTailRef = useRef(-1)
  if (reasoningTailIndex !== previousReasoningTailRef.current) {
    if (!reasoningOwnsSpeed) rootSpeedRef.current = 35
    previousReasoningTailRef.current = reasoningTailIndex
  }
  const updateTextPrediction = useMemo(
    () => (predictive: boolean): void => { rootPredictiveRef.current = predictive },
    [],
  )
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const tail = useTurnData('turn-tail')
  const owner = useMemo<TurnTailOwnerProps | undefined>(() => {
    if (turn?.status !== 'closed' || data.finalNode === undefined) return undefined
    if (tail?.closing?.finalNode.seq !== data.finalNode.seq) return undefined
    return { turn, seq: data.finalNode.seq, openFile }
  }, [data.finalNode, openFile, tail, turn])
  const mentions = useMemo(
    () => owner === undefined ? undefined : fileMentions(owner),
    [fileMentions, owner],
  )
  const markdownLabels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const imageLoader: ImageLoader = loadImage ?? (async () => {
    throw new Error(t('image.serviceUnavailable'))
  })
  const ownsAnyBlock = data.blocks.some(block => belongsToPart(block) && block.kind !== 'tool-call')
  const isPartActiveTail = isFlowPartActiveTail(data.blocks, groupPart)
  const hasVisible = groupPart === undefined
    ? streaming || data.status === 'interrupted' || ownsAnyBlock
    : ownsAnyBlock || (isPartActiveTail && (streaming || data.status === 'interrupted'))
  if (!hasVisible) return null
  const announcementText = data.blocks
    .filter((block): block is Extract<(typeof data.blocks)[number], { kind: 'text' }> =>
      belongsToPart(block) && block.kind === 'text')
    .map(block => block.text)
    .join('\n')

  const rendered: ReactNode[] = []
  let lastFollow = -1
  let lastText = -1
  for (let index = 0; index < data.blocks.length; index += 1) {
    const block = data.blocks[index]
    if (block === undefined || !belongsToPart(block)) continue
    const kind = block.kind
    if (kind === 'text' || kind === 'reasoning') lastFollow = index
    if (kind === 'text') lastText = index
  }
  for (let index = 0; index < data.blocks.length; index += 1) {
    const block = data.blocks[index]
    if (block === undefined) continue
    if (!belongsToPart(block)) continue
    switch (block.kind) {
      case 'text':
        if (!streaming && block.text.trim() === '') break
        rendered.push(
          <AnimatedMarkdownText
            key={index}
            text={block.text}
            labels={markdownLabels}
            fileMentions={mentions}
            streaming={streaming}
            logarithmicFade={logarithmicFade && data.status !== 'interrupted'}
            motionReduced={reduced}
            followSpeedCpsRef={index === lastFollow ? rootSpeedRef : undefined}
            followRevealedCharsRef={index === lastFollow ? rootRevealedCharsRef : undefined}
            followRevealScaleRef={index === lastFollow ? rootRevealScaleRef : undefined}
            onPredictiveChange={index === lastFollow ? updateTextPrediction : undefined}
            onRevealActivityChange={index === lastText ? updateTextRevealActivity : undefined}
            preset={preset}
            shouldHoldBack={shouldHoldBack}
          />,
        )
        break
      case 'reasoning':
        rendered.push(
          <FoldableReasoning key={index} hidden={reasoningHidden} reveal={revealProcess}>
            <AnimatedReasoning
              text={block.text}
              running={streaming && isPartActiveTail && index === lastPartIndex}
              preset={preset}
              thinkAutoExpand={thinkAutoExpand}
              logarithmicFade={logarithmicFade && data.status !== 'interrupted'}
              motionReduced={reduced}
              shouldHoldBack={shouldHoldBack}
              followSpeedCpsRef={reasoningOwnsSpeed && index === lastPartIndex ? rootSpeedRef : undefined}
              followRevealScaleRef={reasoningOwnsSpeed && index === lastPartIndex ? rootRevealScaleRef : undefined}
              followRevealedCharsRef={reasoningOwnsSpeed && index === lastPartIndex ? rootRevealedCharsRef : undefined}
              onPredictiveChange={reasoningOwnsSpeed && index === lastPartIndex ? updateTextPrediction : undefined}
              t={t}
            />
          </FoldableReasoning>,
        )
        break
      case 'image': {
        const start = index
        const group = [block]
        while (index + 1 < data.blocks.length) {
          const next = data.blocks[index + 1]
          if (next === undefined || next.kind !== 'image') break
          group.push(next)
          index += 1
        }
        rendered.push(
          <ImageGallery key={start} images={group} load={imageLoader} align="start" labels={imageLabels(t)} />,
        )
        break
      }
      case 'tool-call':
        break
      case 'other':
        rendered.push(
          <JsonBlock
            key={index}
            label={t('message.unknownBlock')}
            payload={block.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />,
        )
        break
    }
  }

  return (
    <div ref={guardRef} className={css.root} data-streaming={streaming || undefined}>
      <StreamAnnouncement text={announcementText} active={streaming && !reduced} />
      <FollowHost
        // The status can close before its final text arm drains. Retain this
        // same owner across that boundary; the candidate bridges the one
        // layout commit before the child reports its live reveal state.
        active={!reduced && ((streaming && isPartActiveTail) || completionCandidate || textRevealActive)}
        speedCpsRef={rootSpeedRef}
        revealedCharsRef={rootRevealedCharsRef}
        revealScaleRef={rootRevealScaleRef}
        predictiveRef={rootPredictiveRef}
        controlScroll={controlScroll}
      >
        <div className={css.body}>
          {rendered}
          {data.status === 'interrupted'
            && (groupPart === undefined
              || groupPart === 'response'
              || !data.blocks.some(block => block.kind !== 'reasoning' && block.kind !== 'tool-call'))
            && <span className={css.stopped}>{t('message.stopped')}</span>}
        </div>
      </FollowHost>
    </div>
  )
})
