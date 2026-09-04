import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { IconThinkOutline14, JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery, type ImageLoader, type MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import { notifyFollowCommit } from './teleprompterGlide.ts'
import { useSmoothStreamContent, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { useFpsGuard } from './useFpsGuard.ts'
import { FollowHost } from './FollowHost.tsx'
import { DEFAULT_STREAM_CONFIG, type StreamMode } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS, type StreamMotionPreference } from '../settings.ts'
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
 * disables it even when the OS asks for motion.
 */
function useMotionReduced(preference: StreamMotionPreference): boolean {
  const system = usePrefersReducedMotion()
  if (preference === 'force-smooth') return false
  if (preference === 'force-reduced') return true
  return system
}

interface AnimatedMarkdownTextProps extends MarkdownProps {
  streaming: boolean
  /** Whether the OS/forced reduced-motion gate keeps the reveal engine off. */
  motionReduced: boolean
  /** True on the last text block: that block owns conversation follow. */
  ownFollow: boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealedCharsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  onPredictiveChange?: ((predictive: boolean) => void) | undefined
  preset: StreamSmoothingPreset
  shouldHoldBack: () => boolean
  controlScroll?: boolean
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

function measurePendingTextGeometry(root: HTMLElement, visibleText: string): PendingTextGeometry {
  if (
    typeof document.createTreeWalker !== 'function'
    || typeof NodeFilter === 'undefined'
  ) {
    return { root, visibleText, fontSize: 14, wrapThresholdWidth: null }
  }
  const rootRect = root.getBoundingClientRect()
  const rootWidth = Math.max(0, rootRect.width, rootRect.right - rootRect.left, root.clientWidth)
  if (rootWidth <= 0) return { root, visibleText, fontSize: 14, wrapThresholdWidth: null }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let tail: Text | null = null
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? '').length > 0) tail = node as Text
  }
  const parent = tail?.parentElement ?? root
  const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize) || 14
  if (tail === null || typeof document.createRange !== 'function') {
    return { root, visibleText, fontSize, wrapThresholdWidth: rootWidth }
  }

  try {
    const length = tail.textContent?.length ?? 0
    if (length <= 0) return { root, visibleText, fontSize, wrapThresholdWidth: rootWidth }
    const range = document.createRange()
    range.setStart(tail, Math.max(0, length - 1))
    range.setEnd(tail, length)
    const tailRect = range.getBoundingClientRect()
    const contentRight = rootRect.right
    if (!Number.isFinite(tailRect.right) || tailRect.right <= rootRect.left || contentRight <= rootRect.left) {
      return { root, visibleText, fontSize, wrapThresholdWidth: rootWidth }
    }
    const remainingWidth = Math.max(0, contentRight - tailRect.right)
    return {
      root,
      visibleText,
      fontSize,
      wrapThresholdWidth: remainingWidth + fontSize * 0.35,
    }
  } catch {
    return { root, visibleText, fontSize, wrapThresholdWidth: rootWidth }
  }
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
  if (root === null) return pendingChars.length >= PREDICTIVE_WRAP_FALLBACK_CHARS

  let geometry = geometryRef.current
  if (geometry?.root !== root || geometry.visibleText !== visibleText) {
    geometry = measurePendingTextGeometry(root, visibleText)
    geometryRef.current = geometry
  }
  if (geometry.wrapThresholdWidth === null) {
    return pendingChars.length >= PREDICTIVE_WRAP_FALLBACK_CHARS
  }
  return approximateInlineWidth(pending, geometry.fontSize) >= geometry.wrapThresholdWidth
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
 * throughout. The last text block owns conversation-port follow so wraps
 * glide instead of snapping. Once the stream closes and the reveal queue
 * drains, the settled full parse (KaTeX math, fence highlighting, file
 * mentions) swaps in exactly once.
 */
function AnimatedMarkdownText({
  text,
  labels,
  fileMentions,
  streaming,
  motionReduced,
  ownFollow,
  followSpeedCpsRef,
  followRevealedCharsRef,
  followRevealScaleRef,
  onPredictiveChange,
  preset,
  shouldHoldBack,
  controlScroll = true,
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

  // The stream closed: keep revealing the remaining queue, then swap to the
  // settled parse exactly once. The markdown tree stays mounted until then.
  useEffect(() => {
    if (typing && !streaming && shown.length === text.length) setTyping(false)
  }, [shown, streaming, text, typing])

  // A row can mount before the projection flips its assistant step to
  // `running` (the 0.1.2 optimistic submission echo renders the message DOM
  // ahead of stream state), which would freeze `typing` at false forever and
  // leave the reveal engine off for the whole reply. Re-arm on the rising
  // edge so late stream starts are still smoothed.
  useEffect(() => {
    if (streaming) setTyping(true)
  }, [streaming])

  return (
    <FollowHost
      active={live && ownFollow}
      speedCpsRef={speedCpsRef}
      revealedCharsRef={followRevealedCharsRef}
      revealScaleRef={followRevealScaleRef}
      predictive={streaming}
      controlScroll={controlScroll}
      hostRef={followRootRef}
    >
      <MarkdownText
        // `shown` stays authoritative through the completion drain: the
        // settled parse swaps in only when the queue has actually emptied.
        // Rendering `text` early bypasses the drain and teleports the tail.
        text={live ? shown : text}
        streaming={live}
        labels={labels}
        fileMentions={live ? undefined : fileMentions}
      />
    </FollowHost>
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
  shouldHoldBack,
  followSpeedCpsRef,
  followRevealScaleRef,
  t,
}: {
  text: string
  running: boolean
  preset: StreamSmoothingPreset
  thinkAutoExpand: boolean
  motionReduced: boolean
  shouldHoldBack: () => boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  t: AssistantProps['t']
}) {
  const reduced = motionReduced
  const [expanded, setExpanded] = useState(running && thinkAutoExpand)
  const [autoClosed, setAutoClosed] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const commitAnchorRef = useRef<HTMLDivElement>(null)
  // The running→false flip is the AUTO-close: it collapses instantly and the
  // follower's settle spring absorbs the height step. A later manual toggle
  // keeps the CSS glide.
  const displayed = useSmoothStreamContent(text, {
    enabled: running && !reduced,
    preset,
    shouldHoldBack,
    speedCpsRef: followSpeedCpsRef,
    revealScaleRef: followRevealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(commitAnchorRef.current) },
  })
  const shown = running && !reduced ? displayed : text
  const summary = running ? latestLine(shown) : firstLine(text)

  useLayoutEffect(() => {
    // Only the running state owns disclosure while auto-expand is on; with it
    // off, a manual toggle is never wrestled back by the stream.
    if (thinkAutoExpand) {
      setExpanded(running)
      setAutoClosed(!running)
    }
    // A commit that changes this block's height must hand the follower its
    // correction in the SAME task, before the grown-but-uncompensated frame
    // can reach a paint.
    notifyFollowCommit(commitAnchorRef.current)
  }, [running, thinkAutoExpand])

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
          icon={<IconThinkOutline14 size={14} />}
          title="Think"
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
          <div className={css.thinkBody}>{shown}</div>
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
 * outer node owns conversation-port follow while streaming; the final text
 * block keeps ownership while its settled reveal queue drains. The FPS guard
 * holds offscreen reveals when the frame rate is degraded. Settled text
 * renders with the full Markdown pipeline.
 */
export const TypewriterAssistantNodeView = memo(function TypewriterAssistantNodeView({
  mode: _mode = DEFAULT_STREAM_CONFIG.mode,
  preset = DEFAULT_STREAM_CONFIG.preset,
  revealCharsPerSec: _revealCharsPerSec = DEFAULT_STREAM_CONFIG.revealCharsPerSec,
  scrollSpeedPxPerSec: _scrollSpeedPxPerSec = DEFAULT_STREAM_CONFIG.scrollSpeedPxPerSec,
  maxScrollSpeedPxPerSec: _maxScrollSpeedPxPerSec = DEFAULT_STREAM_CONFIG.maxScrollSpeedPxPerSec,
  thinkAutoExpand = DEFAULT_STREAM_SETTINGS.thinkAutoExpand,
  controlScroll = DEFAULT_STREAM_SETTINGS.controlScroll,
  motionPreference = DEFAULT_STREAM_SETTINGS.motionPreference,  node,
  useTurnData,
  openFile,
  loadImage,
  fileMentions,
  t,
}: AssistantProps & {
  mode?: StreamMode
  preset?: StreamSmoothingPreset
  revealCharsPerSec?: number
  scrollSpeedPxPerSec?: number
  maxScrollSpeedPxPerSec?: number
  thinkAutoExpand?: boolean
  controlScroll?: boolean
  motionPreference?: StreamMotionPreference}) {
  const data = node.data
  const streaming = data.status === 'running'
  const reduced = useMotionReduced(motionPreference)
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  const rootSpeedRef = useRef(35)
  const rootRevealedCharsRef = useRef(0)
  const rootRevealScaleRef = useRef(1)
  const reasoningTailIndex = streaming && data.blocks[data.blocks.length - 1]?.kind === 'reasoning'
    ? data.blocks.length - 1
    : -1
  const reasoningOwnsSpeed = reasoningTailIndex !== -1
  const rootPredictiveRef = useRef(false)
  const previousReasoningTailRef = useRef(-1)
  if (reasoningTailIndex !== previousReasoningTailRef.current) {
    // Think growth is already paced by its own text reveal. Opening additional
    // speculative runway here exposes that runway as an empty gap above the
    // fixed turn status, especially when reasoning arrives in fast bursts.
    // The follower still smooths real height growth within the measured gap
    // and catches up any unsafe remainder in the same frame.
    rootPredictiveRef.current = false
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
  const hasVisible = streaming
    || data.status === 'interrupted'
    || data.blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null
  const announcementText = data.blocks
    .filter(block => block.kind === 'text')
    .map(block => block.text)
    .join('\n')

  const rendered: ReactNode[] = []
  const last = data.blocks.length - 1
  let lastFollow = -1
  for (let index = 0; index < data.blocks.length; index += 1) {
    const kind = data.blocks[index]?.kind
    if (kind === 'text' || kind === 'reasoning') lastFollow = index
  }
  for (let index = 0; index < data.blocks.length; index += 1) {
    const block = data.blocks[index]
    if (block === undefined) continue
    switch (block.kind) {
      case 'text':
        rendered.push(
          <AnimatedMarkdownText
            key={index}
            text={block.text}
            labels={markdownLabels}
            fileMentions={mentions}
            streaming={streaming}
            motionReduced={reduced}
            ownFollow={!streaming && index === lastFollow}
            followSpeedCpsRef={index === lastFollow ? rootSpeedRef : undefined}
            followRevealedCharsRef={index === lastFollow ? rootRevealedCharsRef : undefined}
            followRevealScaleRef={index === lastFollow ? rootRevealScaleRef : undefined}
            onPredictiveChange={index === lastFollow ? updateTextPrediction : undefined}
            preset={preset}
            shouldHoldBack={shouldHoldBack}
            controlScroll={controlScroll}
          />,
        )
        break
      case 'reasoning':
        rendered.push(
          <AnimatedReasoning
            key={index}
            text={block.text}
            running={streaming && index === last}
            preset={preset}
            thinkAutoExpand={thinkAutoExpand}
            motionReduced={reduced}
            shouldHoldBack={shouldHoldBack}
            followSpeedCpsRef={reasoningOwnsSpeed && index === last ? rootSpeedRef : undefined}
            followRevealScaleRef={reasoningOwnsSpeed && index === last ? rootRevealScaleRef : undefined}
            t={t}
          />,
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
        active={streaming && !reduced}
        speedCpsRef={rootSpeedRef}
        revealedCharsRef={rootRevealedCharsRef}
        revealScaleRef={rootRevealScaleRef}
        predictiveRef={rootPredictiveRef}
        controlScroll={controlScroll}
      >
        <div className={css.body}>
          {rendered}
          {data.status === 'interrupted' && <span className={css.stopped}>{t('message.stopped')}</span>}
        </div>
      </FollowHost>
    </div>
  )
})
