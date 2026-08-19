import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { IconThinkOutline14, JsonBlock, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageGallery, type ImageLoader, type MessageImageLabels } from '@deepseek-ai/dsh-client-ui-attachment'
import type { ChatNodeViewProps, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AnimatedDisclosure } from './AnimatedDisclosure.tsx'
import { useSmoothStreamContent, type StreamSmoothingPreset } from './useSmoothStreamContent.ts'
import { useFpsGuard } from './useFpsGuard.ts'
import { FollowHost } from './FollowHost.tsx'
import { DEFAULT_STREAM_CONFIG, type StreamMode } from '../config.ts'
import { DEFAULT_STREAM_SETTINGS } from '../settings.ts'
import css from './TypewriterAssistantNodeView.module.css'

type AssistantProps = ChatNodeViewProps<'assistant-step'>
type MarkdownProps = Pick<ComponentProps<typeof MarkdownText>, 'codeLabels' | 'fileMentions' | 'text'>

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

interface AnimatedMarkdownTextProps extends MarkdownProps {
  streaming: boolean
  announce: boolean
  /** True on the last text block: that block owns conversation follow. */
  ownFollow: boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  onPredictiveChange?: ((predictive: boolean) => void) | undefined
  preset: StreamSmoothingPreset
  shouldHoldBack: () => boolean
}

/** Conservative fallback before the streaming Markdown tail has geometry. */
const PREDICTIVE_WRAP_FALLBACK_CHARS = 32

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
function pendingTextCanGrow(root: HTMLElement | null, pending: string): boolean {
  if (pending === '') return false
  if (/[\r\n]/u.test(pending)) return true
  const pendingChars = [...pending]
  if (
    root === null
    || typeof document.createTreeWalker !== 'function'
    || typeof NodeFilter === 'undefined'
  ) {
    return pendingChars.length >= PREDICTIVE_WRAP_FALLBACK_CHARS
  }

  const rootRect = root.getBoundingClientRect()
  const rootWidth = Math.max(0, rootRect.width, rootRect.right - rootRect.left, root.clientWidth)
  if (rootWidth <= 0) return pendingChars.length >= PREDICTIVE_WRAP_FALLBACK_CHARS

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let tail: Text | null = null
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node.textContent ?? '').length > 0) tail = node as Text
  }
  const parent = tail?.parentElement ?? root
  const fontSize = Number.parseFloat(getComputedStyle(parent).fontSize) || 14
  const pendingWidth = approximateInlineWidth(pending, fontSize)
  if (tail === null || typeof document.createRange !== 'function') {
    return pendingWidth >= rootWidth
  }

  try {
    const length = tail.textContent?.length ?? 0
    if (length <= 0) return pendingWidth >= rootWidth
    const range = document.createRange()
    range.setStart(tail, Math.max(0, length - 1))
    range.setEnd(tail, length)
    const tailRect = range.getBoundingClientRect()
    const contentRight = rootRect.right
    if (!Number.isFinite(tailRect.right) || tailRect.right <= rootRect.left || contentRight <= rootRect.left) {
      return pendingWidth >= rootWidth
    }
    const remainingWidth = Math.max(0, contentRight - tailRect.right)
    return pendingWidth >= remainingWidth + fontSize * 0.35
  } catch {
    return pendingWidth >= rootWidth
  }
}

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
  codeLabels,
  fileMentions,
  streaming,
  announce,
  ownFollow,
  followSpeedCpsRef,
  followRevealScaleRef,
  onPredictiveChange,
  preset,
  shouldHoldBack,
}: AnimatedMarkdownTextProps) {
  const reduced = usePrefersReducedMotion()
  const [typing, setTyping] = useState(streaming)
  const localSpeedCpsRef = useRef(35)
  const followRootRef = useRef<HTMLDivElement>(null)
  const predictionSourceRef = useRef<string | null>(null)
  const predictionStateRef = useRef(false)
  const speedCpsRef = followSpeedCpsRef ?? localSpeedCpsRef
  const displayed = useSmoothStreamContent(text, {
    enabled: typing && !reduced,
    inputComplete: !streaming,
    preset,
    shouldHoldBack,
    speedCpsRef,
    revealScaleRef: followRevealScaleRef,
  })
  const shown = reduced ? text : displayed
  const live = typing && !reduced

  useLayoutEffect(() => {
    if (onPredictiveChange === undefined) return
    const pending = text.slice(shown.length)
    const sourceChanged = predictionSourceRef.current !== text
    const next = !live || !streaming || pending === ''
      ? false
      : sourceChanged
        ? pendingTextCanGrow(followRootRef.current, pending)
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

  return (
    <>
      {live && announce && <span className={css.visuallyHidden} aria-live="polite">{text}</span>}
      <FollowHost
        active={live && ownFollow}
        speedCpsRef={speedCpsRef}
        revealScaleRef={followRevealScaleRef}
        predictive={streaming}
        hostRef={followRootRef}
      >
        <MarkdownText
          text={live ? shown : text}
          streaming={live}
          codeLabels={codeLabels}
          fileMentions={live ? undefined : fileMentions}
        />
      </FollowHost>
    </>
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
  shouldHoldBack,
  followSpeedCpsRef,
  followRevealScaleRef,
  onExpandedChange,
  t,
}: {
  text: string
  running: boolean
  preset: StreamSmoothingPreset
  thinkAutoExpand: boolean
  shouldHoldBack: () => boolean
  followSpeedCpsRef?: { current: number } | undefined
  followRevealScaleRef?: { current: number } | undefined
  onExpandedChange?: ((expanded: boolean) => void) | undefined
  t: AssistantProps['t']
}) {
  const reduced = usePrefersReducedMotion()
  const [expanded, setExpanded] = useState(running && thinkAutoExpand)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const displayed = useSmoothStreamContent(text, {
    enabled: running && !reduced,
    preset,
    shouldHoldBack,
    speedCpsRef: followSpeedCpsRef,
    revealScaleRef: followRevealScaleRef,
  })
  const shown = running && !reduced ? displayed : text
  const summary = running ? latestLine(shown) : firstLine(text)

  useLayoutEffect(() => {
    // Only the running state owns disclosure while auto-expand is on; with it
    // off, a manual toggle is never wrestled back by the stream.
    if (thinkAutoExpand) setExpanded(running)
  }, [running, thinkAutoExpand])

  useLayoutEffect(() => {
    onExpandedChange?.(expanded)
  }, [expanded, onExpandedChange])

  useEffect(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  }, [running, summary])

  // Preserve FollowHost's layout wrapper without mounting a second scroll owner.
  return (
    <div className={css.follow}>
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
          onToggle={() => { setExpanded(value => !value) }}
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
  node,
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
}) {
  const data = node.data
  const streaming = data.status === 'running'
  const reduced = usePrefersReducedMotion()
  const { ref: guardRef, shouldHoldBack } = useFpsGuard(streaming)
  const rootSpeedRef = useRef(35)
  const rootRevealScaleRef = useRef(1)
  const reasoningTailIndex = streaming && data.blocks[data.blocks.length - 1]?.kind === 'reasoning'
    ? data.blocks.length - 1
    : -1
  const reasoningOwnsSpeed = reasoningTailIndex !== -1
  const rootPredictiveRef = useRef(false)
  const previousReasoningTailRef = useRef(-1)
  if (reasoningTailIndex !== previousReasoningTailRef.current) {
    rootPredictiveRef.current = reasoningOwnsSpeed ? thinkAutoExpand : false
    if (!reasoningOwnsSpeed) rootSpeedRef.current = 35
    previousReasoningTailRef.current = reasoningTailIndex
  }
  const updateReasoningExpanded = useMemo(
    () => (expanded: boolean): void => { rootPredictiveRef.current = expanded },
    [],
  )
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
  const codeLabels = useMemo(() => ({ copyLabel: t('copy'), copiedLabel: t('copied') }), [t])
  const imageLoader: ImageLoader = loadImage ?? (async () => {
    throw new Error(t('image.serviceUnavailable'))
  })
  const hasVisible = streaming
    || data.status === 'interrupted'
    || data.blocks.some(block => block.kind !== 'tool-call')
  if (!hasVisible) return null

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
            codeLabels={codeLabels}
            fileMentions={mentions}
            streaming={streaming}
            announce={index === last}
            ownFollow={!streaming && index === lastFollow}
            followSpeedCpsRef={index === lastFollow ? rootSpeedRef : undefined}
            followRevealScaleRef={index === lastFollow ? rootRevealScaleRef : undefined}
            onPredictiveChange={index === lastFollow ? updateTextPrediction : undefined}
            preset={preset}
            shouldHoldBack={shouldHoldBack}
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
            shouldHoldBack={shouldHoldBack}
            followSpeedCpsRef={reasoningOwnsSpeed && index === last ? rootSpeedRef : undefined}
            followRevealScaleRef={reasoningOwnsSpeed && index === last ? rootRevealScaleRef : undefined}
            onExpandedChange={index === reasoningTailIndex ? updateReasoningExpanded : undefined}
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
      <FollowHost
        active={streaming && !reduced}
        speedCpsRef={rootSpeedRef}
        revealScaleRef={rootRevealScaleRef}
        predictiveRef={rootPredictiveRef}
      >
        <div className={css.body}>
          {rendered}
          {data.status === 'interrupted' && <span className={css.stopped}>{t('message.stopped')}</span>}
        </div>
      </FollowHost>
    </div>
  )
})
