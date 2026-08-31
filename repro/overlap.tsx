/**
 * Inline-code wrap overlap probe (Issue #13).
 *
 * Renders issue-#13-style markdown (a list item whose long inline `<code>`
 * wraps to a second line at a narrow container width) through the REAL harness
 * `MarkdownText` — it is the renderer that owns the streaming DOM — under three
 * arms that isolate where an overlap could be introduced:
 *
 *   static  - full text rendered once (settled), NO plugin at all. Control:
 *             if this arm overlaps, the HTML/CSS over the renderer is at fault.
 *   reveal  - same renderer, text paced by the plugin's reveal smoother, but
 *             NO follow engine, NO transforms. Isolates the reveal-string
 *             mutations (partial inline code reflow) as an overlap source.
 *   engine  - reveal + FollowHost + real scroll contract + surface transforms.
 *             Isolates the follow engine (stale transform, cross-surface shift).
 *
 * Overlap detection is surface-transform-INVARIANT on purpose: the two list
 * items live in the same follower surface and move together under the engine's
 * translate3d. The probe checks both layout-box gaps and descendant text Range
 * gaps, so an inline-flex paint overflow cannot hide behind a clean `li` box.
 *
 * Per-frame probes record the li-pair gaps plus engine internals (lag / reserve
 * / capacity / shift / runway / scrollTop / floor) so an incident carries
 * attribution context. A residual-transform scan runs after settle + quiet.
 *
 * Driver surface:
 *   window.__overlapStart(arm, variant, { cps, width })
 *   window.__overlapPhase(name)
 *   window.__overlapReport()      -> { violations, context, phases, ... }
 *   window.__overlapReady         -> boolean
 *
 * The esbuild build aliases `katex/dist/katex.min.css` to an empty stub; this
 * fixture has no TeX, so dropping KaTeX fonts keeps the bundle self-contained.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { FollowHost } from '../src/client/FollowHost.tsx'
import { useSmoothStreamContent } from '../src/client/useSmoothStreamContent.ts'
import { notifyFollowCommit } from '../src/client/teleprompterGlide.ts'
import { debugRuntime } from '../src/client/debugRuntime.ts'
import css from '../src/client/TypewriterAssistantNodeView.module.css'
import markdownCss from '../../deepseek-harness/packages/client/ui-primitives/src/markdown/MarkdownText.module.css'

/* ------------------------------- fixtures --------------------------------- */

export type OverlapArm = 'static' | 'reveal' | 'engine'

export const FIXTURES: Record<string, string> = {
  // Issue #13 verbatim: the first item's inline code wraps; the report says
  // its second line rides over "内容包含：…".
  issue: [
    '- 标题：`[FEAT] Retention policy for ~/.dsh/rewind-snapshots (auto-cleanup of finished sessions\' snapshots)`',
    '- 内容包含：当前无上限增长的行为描述、建议的配置设计（maxAgeDays + maxTotalMb LRU）、惰性清理时机建议',
  ].join('\n'),
  // Long CJK inline code: wraps between CJK codepoints regardless of whitespace.
  cjk: [
    '- 长码：`这是一段相当长的中文行内代码段，用来在窄容器里强制折成两行并检验第二行是否会与下一条列表项发生重叠`，后面再接普通文字继续观察',
    '- 下一项：看看与上一行的最后一个行盒是否重叠',
  ].join('\n'),
  // Long ASCII token with spaces (wraps at word boundaries like the issue).
  ascii: [
    '- Token: `const RETENTION_POLICY = Object.freeze({ maxAgeDays: 365, maxTotalMb: 4096, lazy: true, logRetentionMs: 90 * 24 * 3600 });` very long token line',
    '- Next: watch whether this second item rides up over the wrapped token line above',
  ].join('\n'),
  // No inline code at all: control for code-specific behavior.
  nocode: [
    '- 第一项：完全没有行内代码的普通列表项，内容刻意写长以保证折行，用来排除「代码无关」的几何异常',
    '- 第二项：普通文字，继续一些内容让第二行也参与换行',
    '- 第三项：普通文字，继续一些内容',
  ].join('\n'),
}

export const FIXTURE_VARIANTS = ['issue', 'cjk', 'ascii', 'nocode'] as const

/* ----------------------------- geometry utils ---------------------------- */

function scrollerOf(from: HTMLElement): HTMLElement {
  return from.closest<HTMLElement>('[data-conversation-scroll]') ?? from
}

/** Consecutive `<li>` box gaps inside one list; surface-transform invariant. */
function collectLiGaps(root: HTMLElement | null): number[] {
  if (root === null) return []
  const gaps: number[] = []
  for (const list of root.querySelectorAll('ul, ol')) {
    const items = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.tagName === 'LI')
    for (let index = 1; index < items.length; index += 1) {
      const top = items[index]!.getBoundingClientRect().top
      const bottom = items[index - 1]!.getBoundingClientRect().bottom
      gaps.push(top - bottom)
    }
  }
  return gaps
}

/**
 * Painted-text gaps between consecutive `<li>`s, from text Range line boxes
 * (not the layout boxes). text-box-trim / atomic inline boxes can shrink an
 * `li`'s LAYOUT box below the height of a wrapped inline code's PAINTED lines;
 * the boxes then touch cleanly while the previous item's text still overlaps
 * the next item's first line. Only Range geometry sees that.
 */
function collectLiVisualGaps(root: HTMLElement | null): number[] {
  if (root === null) return []
  const gaps: number[] = []
  for (const list of root.querySelectorAll('ul, ol')) {
    const items = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.tagName === 'LI')
    const extents = items.map(item => {
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
      let top = Number.POSITIVE_INFINITY
      let bottom = Number.NEGATIVE_INFINITY
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        if (text.length === 0) continue
        const range = document.createRange()
        range.setStart(node, 0)
        range.setEnd(node, text.length)
        for (const rect of range.getClientRects()) {
          if (rect.width <= 0 || rect.height <= 0) continue
          top = Math.min(top, rect.top)
          bottom = Math.max(bottom, rect.bottom)
        }
      }
      if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
        const rect = item.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom }
      }
      return { top, bottom }
    })
    for (let index = 1; index < extents.length; index += 1) {
      gaps.push(extents[index]!.top - extents[index - 1]!.bottom)
    }
  }
  return gaps
}

interface MessageEdges {
  /** Assistant message bottom → status-row top (cross-surface gap, px). */
  statusGap: number
  /** Transforms currently painted on flow children / status. */
  transforms: string[]
}

function measureMessageEdges(): MessageEdges {
  const message = document.querySelector<HTMLElement>('[data-probe-surface="a1"]')
  const status = document.querySelector<HTMLElement>('[data-probe-status]')
  let statusGap = Number.NaN
  if (message !== null && status !== null && status.getClientRects().length > 0) {
    statusGap = status.getBoundingClientRect().top - message.getBoundingClientRect().bottom
  }
  const flow = document.querySelector<HTMLElement>('[data-chat-flow]')
  const transforms: string[] = []
  if (flow !== null) {
    for (const child of [...flow.children, ...(status === null ? [] : [status])]) {
      if (child instanceof HTMLElement && child.style.transform !== '') transforms.push(child.style.transform)
    }
  }
  return { statusGap, transforms }
}

function lineHeightPxOf(el: HTMLElement): number {
  const v = Number.parseFloat(getComputedStyle(el).lineHeight)
  return Number.isFinite(v) && v > 0 ? v : 28
}

/** True when the first list item's code/box wraps to >1 line (fixture sanity). */
function measureWrapped(root: HTMLElement | null): boolean {
  const firstList = root?.querySelector('ul, ol')
  const firstItem = firstList?.querySelector('li')
  if (firstItem === undefined || firstItem === null || !(firstItem instanceof HTMLElement)) return false
  // Prefer the inline code box: with text-box-trim a trimmed `li` box stays
  // one line high even when the code paints two (the very overlap mechanism).
  const target = firstItem.querySelector('code') ?? firstItem
  if (!(target instanceof HTMLElement)) return false
  const line = lineHeightPxOf(target)
  return target.getBoundingClientRect().height > line * 1.5
}

/* ------------------------------- arms ----------------------------------- */

const mdRoot = (children: ReactNode): ReactNode => <div className={`${markdownCss.markdown} mdRoot`}>{children}</div>

function StreamedMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return <MarkdownText text={text} streaming={streaming} />
}

/** Control arm: settled full text, no plugin involvement at all. */
function StaticArm({ text }: { text: string }) {
  return (
    <div className={`${css.root} msg assistant`} data-chat-anchor-key="a1" data-probe-surface="a1">
      <div className={css.body}>{mdRoot(<StreamedMarkdown text={text} streaming={false} />)}</div>
    </div>
  )
}

/** Reveal arm: real renderer + reveal smoothness, but no follow engine. */
function RevealArm({
  text,
  streaming,
  cps,
  onDrained,
}: {
  text: string
  streaming: boolean
  cps: number
  onDrained: () => void
}) {
  const [typing, setTyping] = useState(streaming)
  const speedCpsRef = useRef(35)
  const revealedCharsRef = useRef(0)
  const revealScaleRef = useRef(1)
  const displayed = useSmoothStreamContent(text, {
    enabled: typing,
    inputComplete: !streaming,
    preset: 'balanced',
    steadyCps: cps,
    speedCpsRef,
    revealedCharsRef,
    revealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(document.querySelector('[data-conversation-scroll]')) },
  })
  const drainedRef = useRef(false)
  useEffect(() => {
    if (streaming) {
      setTyping(true)
      drainedRef.current = false
      return
    }
    // `text.length > 0` gates the mount phantom: at mount both displayed and
    // text are '' (0 === 0), which would otherwise fire a fake drained phase.
    if (text.length > 0 && displayed.length === text.length && !drainedRef.current) {
      drainedRef.current = true
      setTyping(false)
      onDrained()
    }
  }, [displayed.length, streaming, text.length, onDrained])
  return (
    <div className={`${css.root} msg assistant`} data-chat-anchor-key="a1" data-probe-surface="a1" data-streaming={typing || undefined}>
      <div className={css.body}>{mdRoot(<StreamedMarkdown text={typing ? displayed : text} streaming={typing} />)}</div>
    </div>
  )
}

/** Engine arm: reveal + FollowHost + real host scroll contract + transforms. */
function EngineArm({
  text,
  streaming,
  cps,
  onDrained,
}: {
  text: string
  streaming: boolean
  cps: number
  onDrained: () => void
}) {
  const [typing, setTyping] = useState(streaming)
  const followRootRef = useRef<HTMLDivElement>(null)
  const rootSpeedCpsRef = useRef(35)
  const rootRevealedCharsRef = useRef(0)
  const rootRevealScaleRef = useRef(1)
  const displayed = useSmoothStreamContent(text, {
    enabled: typing,
    inputComplete: !streaming,
    preset: 'balanced',
    steadyCps: cps,
    speedCpsRef: rootSpeedCpsRef,
    revealedCharsRef: rootRevealedCharsRef,
    revealScaleRef: rootRevealScaleRef,
    onRevealCommit: () => { notifyFollowCommit(followRootRef.current) },
  })
  const drainedRef = useRef(false)
  useEffect(() => {
    if (streaming) {
      setTyping(true)
      drainedRef.current = false
      return
    }
    // `text.length > 0` gates the mount phantom; see RevealArm.
    if (text.length > 0 && displayed.length === text.length && !drainedRef.current) {
      drainedRef.current = true
      setTyping(false)
      onDrained()
    }
  }, [displayed.length, streaming, text.length, onDrained])
  return (
    <div className={`${css.root} msg assistant`} data-chat-anchor-key="a1" data-probe-surface="a1" data-streaming={typing || undefined}>
      <FollowHost
        hostRef={followRootRef}
        active={typing}
        predictive={streaming}
        speedCpsRef={rootSpeedCpsRef}
        revealedCharsRef={rootRevealedCharsRef}
        revealScaleRef={rootRevealScaleRef}
      >
        <div className={css.body}>{mdRoot(<StreamedMarkdown text={typing ? displayed : text} streaming={typing} />)}</div>
      </FollowHost>
    </div>
  )
}

/* ------------------------------ host shell ------------------------------- */

const FILLER = [
  '第一则填充上下文，用于让对话在引擎臂产生真实溢出从而驱动滚动跟随：',
  '这里故意把内容排得比较高，让下面的助手消息出现在折线以下、滚动区拥有可跟随的地板。',
  '再多来两行，确保任何一次 reveal 增量都落在真实 overflow 区间。',
].join('\n')

const OVERFLOW_PAD = ['高一点。', '再高一点。', '继续增高。', '保持溢出。'].join(' ')

function OverlapHost() {
  const [runId, setRunId] = useState(0)
  const [arm, setArm] = useState<OverlapArm | null>(null)
  const [variant, setVariant] = useState<keyof typeof FIXTURES | null>(null)
  const [text, setText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [drained, setDrained] = useState(false)
  const [width, setWidth] = useState(640)
  const [cps, setCps] = useState(600)

  const onDrained = useCallback(() => {
    setDrained(true)
    window.__overlapPhase('drained')
  }, [])

  // Chunked fixture driver: appends real characters at the target reveal cadence.
  useEffect(() => {
    if (arm === null || variant === null || !streaming) return
    if (arm === 'static') return
    const fixture = FIXTURES[variant] ?? ''
    const total = fixture.length
    let emitted = 0
    let carry = 0
    const intervalMs = 25
    const id = window.setInterval(() => {
      carry += cps * intervalMs / 1000
      let take = Math.max(1, Math.round(carry))
      carry -= take
      const remaining = total - emitted
      if (take >= remaining) take = remaining
      emitted += take
      setText(prev => prev + fixture.slice(prev.length, emitted))
      if (emitted >= total) {
        window.clearInterval(id)
        setStreaming(false)
        window.__overlapPhase('produced')
      }
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [arm, cps, streaming, variant])

  const start = useCallback((
    nextArm: OverlapArm,
    nextVariant: keyof typeof FIXTURES,
    opts: { cps?: number; width?: number; liTrim?: boolean; codeInline?: boolean } = {},
  ): void => {
    window.__overlapReset()
    // CSS state mirrors (see overlap.html): pre-fix li text-box-trim reproduces
    // the reported paint overlap; post-fix inline code removes it.
    if (opts.liTrim === true) document.documentElement.dataset.liTrim = '1'
    else delete document.documentElement.dataset.liTrim
    if (opts.codeInline === true) document.documentElement.dataset.codeInline = '1'
    else delete document.documentElement.dataset.codeInline
    const flow = document.querySelector<HTMLElement>('[data-chat-flow]')
    if (flow !== null) {
      flow.style.minHeight = ''
      flow.style.overflowAnchor = ''
      for (const child of [...flow.children]) {
        if (child instanceof HTMLElement) {
          child.style.transform = ''
          child.style.willChange = ''
          child.style.marginTop = ''
          child.style.marginBottom = ''
        }
      }
    }
    const size = opts.width ?? 640
    setWidth(size)
    setCps(opts.cps ?? 600)
    setArm(nextArm)
    setVariant(nextVariant)
    setText('')
    setDrained(false)
    setStreaming(false)
    setRunId(id => id + 1) // full remount per run
    window.__overlapSetConfig({ arm: nextArm, variant: nextVariant, cps: opts.cps ?? 600, width: size })
    // Deferred streaming flip (one rAF later): lets the remount settle with an
    // empty tree first. An in-task streaming=true here froze the page's timer
    // delivery after the first few reveal ticks in headless Chromium, stalling
    // the reveal driver, so the rAF deferral is load-bearing.
    requestAnimationFrame(() => {
      window.__overlapPhase('started')
      if (nextArm === 'static') {
        window.__overlapPhase('produced')
        window.__overlapPhase('drained')
        setDrained(true)
      } else {
        setStreaming(true)
      }
    })
  }, [])

  useEffect(() => {
    window.__overlapStart = start
  }, [start])

  const fixture = variant === null ? '' : (FIXTURES[variant] ?? '')
  const showProbe = arm !== null && variant !== null

  return (
    <div className="root" key={runId}>
      <div className="scrollBody" data-conversation-scroll="" tabIndex={0}>
        <div className="scroll">
          <div className="column" data-chat-flow="" style={{ width: `min(${width}px, 92%)` }}>
            <div className="msg user" data-chat-anchor-key="f0">
              <div className="mdRoot">{OVERFLOW_PAD}</div>
            </div>
            <div className="msg filler" data-chat-anchor-key="f1">
              <div className="mdRoot">{FILLER}</div>
            </div>
            {showProbe && arm === 'static' && <StaticArm text={fixture} />}
            {showProbe && arm === 'reveal' && (
              <RevealArm text={text} streaming={streaming} cps={cps} onDrained={onDrained} />
            )}
            {showProbe && arm === 'engine' && (
              <EngineArm text={text} streaming={streaming} cps={cps} onDrained={onDrained} />
            )}
            {showProbe && (
              <div role="status" className="statusRow" data-probe-status="">
                <span className="dots">{streaming ? '正在深度思考…' : '已完成'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="composerSeat" data-composer-seat="">
        <input placeholder="输入消息…" />
        <button>发送</button>
      </div>
    </div>
  )
}

/* ----------------------------- instrumentation --------------------------- */

interface OViolation {
  kind: string
  t: number
  detail: string
}

interface OSample {
  t: number
  dt: number
  gaps: number[]
  visualGaps: number[]
  minGap: number
  edges: MessageEdges
  /** Engine internals for attribution (NaN outside engine arm / fallback). */
  lag: number
  capacity: number
  reserve: number
  revealScale: number
  following: boolean
  constrained: boolean
  shift: number
}

const OVERLAP_GAP_PX = -1.5
const QUIET_MS = 700
const WATCHDOG_MS = 15000

interface OverlapState {
  arm: OverlapArm | null
  variant: keyof typeof FIXTURES | null
  cps: number
  width: number
  samples: OSample[]
  phases: Array<{ name: string; t: number }>
  shifts: Array<{ t: number; value: number; sources: string[] }>
  last: number | null
  raf: number
  ready: boolean
}

declare global {
  interface Window {
    __overlapStart: (
      arm: OverlapArm,
      variant: keyof typeof FIXTURES,
      opts?: { cps?: number; width?: number; liTrim?: boolean; codeInline?: boolean },
    ) => void
    __overlapPhase: (name: string) => void
    __overlapReset: () => void
    __overlapReport: () => unknown
    __overlapSetConfig: (config: { arm: OverlapArm; variant: string; cps: number; width: number }) => void
    __overlapReady?: boolean
    __overlapData?: {
      arm: OverlapArm | null
      variant: keyof typeof FIXTURES | null
      cps: number
      width: number
    }
  }
}

function installOverlap(): void {
  const state: OverlapState = {
    arm: null,
    variant: null,
    cps: 600,
    width: 640,
    samples: [],
    phases: [],
    shifts: [],
    last: null,
    raf: 0,
    ready: false,
  }

  window.__overlapSetConfig = (config): void => {
    state.arm = config.arm
    state.variant = config.variant as keyof typeof FIXTURES
    state.cps = config.cps
    state.width = config.width
    window.__overlapData = { arm: state.arm, variant: state.variant, cps: state.cps, width: state.width }
  }

  window.__overlapPhase = (name: string): void => {
    state.phases.push({ name, t: performance.now() })
  }

  window.__overlapReset = (): void => {
    cancelAnimationFrame(state.raf)
    state.samples = []
    state.phases = []
    state.shifts = []
    state.last = null
    state.ready = false
    window.__overlapReady = false
    try { window.__shiftObserver?.disconnect() } catch {}
    state.raf = requestAnimationFrame(sampleLoop)
  }

  const probe = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-probe-surface="a1"]')

  const sampleLoop = (now: number): void => {
    const port = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (port === null) {
      state.raf = requestAnimationFrame(sampleLoop)
      return
    }
    const drainedT = state.phases.find(phase => phase.name === 'drained')?.t
    const producedT = state.phases.find(phase => phase.name === 'produced')?.t
    const lastPhaseT = state.phases.at(-1)?.t ?? 0
    // A run is only "really drained" once it actually produced content: the
    // mount phantom is gated by `text.length > 0`, so 'drained' here always
    // follows a real producer.
    const quietComplete = producedT !== undefined
      && drainedT !== undefined
      && now - drainedT >= QUIET_MS
    const watchdog = state.phases.length > 0 && now - lastPhaseT > WATCHDOG_MS
    if (quietComplete || watchdog) {
      state.ready = true
      window.__overlapReady = true
      return
    }
    state.raf = requestAnimationFrame(sampleLoop)
    const dt = state.last === null ? 16.7 : now - state.last
    state.last = now
    const gaps = collectLiGaps(probe())
    const visualGaps = collectLiVisualGaps(probe())
    const engine = window.__debugOverlap?.()
    const surfaceShift = Number(
      /translate3d\(0(?:px)?,\s*(-?[\d.]+)px/.exec(probe()?.style.transform ?? '')?.[1] ?? 0,
    )
    state.samples.push({
      t: now,
      dt,
      gaps,
      visualGaps,
      minGap: gaps.length > 0 ? Math.min(...gaps) : Number.NaN,
      edges: measureMessageEdges(),
      lag: engine?.followLagPx ?? Number.NaN,
      capacity: engine?.followCapacityPx ?? Number.NaN,
      reserve: engine?.followReservePx ?? Number.NaN,
      revealScale: engine?.followRevealScale ?? Number.NaN,
      following: engine?.followFollowing ?? false,
      constrained: engine?.followConstrained ?? false,
      shift: surfaceShift,
    })
  }

  window.__overlapReport = (): unknown => {
    cancelAnimationFrame(state.raf)
    const violations: OViolation[] = []
    const pins: number[] = []
    const push = (kind: string, t: number, detail: string, index: number): void => {
      if (violations.length < 400) {
        violations.push({ kind, t, detail })
        pins.push(index)
      }
    }

    const endpoint = state.arm
    const variantName = String(state.variant ?? '')
    const probeRoot = probe()
    const wrapped = endpoint !== null ? measureWrapped(probeRoot) : false

    // Per-frame violation scan.
    for (let index = 0; index < state.samples.length; index += 1) {
      const sample = state.samples[index]!
      const gaps = sample.gaps
      for (let g = 0; g < gaps.length; g += 1) {
        if (gaps[g]! < OVERLAP_GAP_PX) {
          push('overlap', sample.t, `li pair ${g + 1} gap=${gaps[g]!.toFixed(2)}px (within-message)`, index)
        }
      }
      for (let g = 0; g < sample.visualGaps.length; g += 1) {
        if (sample.visualGaps[g]! < OVERLAP_GAP_PX) {
          push('visual-overlap', sample.t, `li paint pair ${g + 1} gap=${sample.visualGaps[g]!.toFixed(2)}px`, index)
        }
      }
      if (Number.isFinite(sample.edges.statusGap) && sample.edges.statusGap < OVERLAP_GAP_PX) {
        push('cross-overlap', sample.t, `assistant bottom→status gap=${sample.edges.statusGap.toFixed(2)}px`, index)
      }
    }

    // Persistent overlap at report time (after settle): the reporter's symptom
    // "输出结束后仍残留".
    const finalGaps = collectLiGaps(probeRoot)
    const finalVisualGaps = collectLiVisualGaps(probeRoot)
    for (let g = 0; g < finalGaps.length; g += 1) {
      if (finalGaps[g]! < OVERLAP_GAP_PX) {
        push('residual-overlap', performance.now(), `li pair ${g + 1} still overlapping at rest: gap=${finalGaps[g]!.toFixed(2)}px`, state.samples.length - 1)
      }
    }
    for (let g = 0; g < finalVisualGaps.length; g += 1) {
      if (finalVisualGaps[g]! < OVERLAP_GAP_PX) {
        push('residual-visual-overlap', performance.now(), `li paint pair ${g + 1} still overlapping at rest: gap=${finalVisualGaps[g]!.toFixed(2)}px`, state.samples.length - 1)
      }
    }

    // Residual surface transform at rest.
    const residual = measureMessageEdges()
    for (const transform of residual.transforms) {
      push('residual-transform', performance.now(), `non-empty transform at rest: ${transform}`, state.samples.length - 1)
    }

    // Attribution context around each overlap incident.
    const engineLine = (sample: OSample): string =>
      ` > sft=${sample.shift.toFixed(1)}`
      + (Number.isFinite(sample.lag)
        ? ` lag=${sample.lag.toFixed(0)} cap=${Number.isFinite(sample.capacity) ? sample.capacity.toFixed(0) : '?'} rsv=${sample.reserve.toFixed(0)}`
        : ' lag=?(no engine)')
      + ` following=${sample.following}${sample.constrained ? ' CONSTRAINED' : ''}`

    const context: Record<string, string[]> = {}
    for (let v = 0; v < violations.length; v += 1) {
      const kind = violations[v]!.kind
      if ((context[kind] ?? []).length >= 3) continue
      const index = pins[v]!
      const from = Math.max(0, index - 3)
      const to = Math.min(state.samples.length, index + 4)
      const lines: string[] = []
      for (let s = from; s < to; s += 1) {
        const sample = state.samples[s]!
        lines.push(
          `t+${Math.round(sample.t - violations[v]!.t)}ms `
          + `liGaps=[${sample.gaps.map(value => value.toFixed(1)).join(',')}]`
          + ` statusGap=${Number.isFinite(sample.edges.statusGap) ? sample.edges.statusGap.toFixed(1) : '-'}`
          + ` top=${portOf()?.scrollTop ?? -1}${engineLine(sample)}`,
        )
      }
      context[kind] ??= []
      context[kind]!.push(lines.join('\n'))
    }

    return {
      arm: endpoint,
      variant: variantName,
      cps: state.cps,
      width: state.width,
      wrapped,
      liGapCount: finalGaps.length,
      visualLiGaps: finalVisualGaps,
      samples: state.samples.length,
      phases: state.phases,
      violations,
      context,
      residualTransforms: residual.transforms,
      timeline: state.samples.map(s =>
        `${Math.round(s.t - (state.phases[0]?.t ?? 0))}ms li=${s.gaps.map(v => v.toFixed(1)).join(',')} stGap=${Number.isFinite(s.edges.statusGap) ? s.edges.statusGap.toFixed(1) : '-'} sft=${s.shift.toFixed(1)}${Number.isFinite(s.lag) ? ` lag=${s.lag.toFixed(0)} rw?` : ''}${s.constrained ? ' C' : ''}`),
    }
  }

  function portOf(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-conversation-scroll]')
  }

  window.__debugOverlap = (): ReturnType<typeof debugRuntime.getSnapshot>['metrics'] | undefined => {
    try {
      return debugRuntime.getSnapshot().metrics
    } catch {
      return undefined
    }
  }

  if (typeof PerformanceObserver !== 'undefined') {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { value: number; sources?: Array<{ node?: Node | null }> }
        if (shift.value <= 0) continue
        state.shifts.push({
          t: entry.startTime,
          value: shift.value,
          sources: (shift.sources ?? []).slice(0, 4).map(source => {
            const node = source.node
            if (node instanceof HTMLElement) return `${node.tagName.toLowerCase()}${node.className ? `.${String(node.className).split(' ')[0]}` : ''}`
            return node?.nodeName ?? '?'
          }),
        })
      }
    })
    observer.observe({ type: 'layout-shift', buffered: false })
    window.__shiftObserver = observer
  }

  window.__overlapReset()
}

declare global {
  interface Window {
    __debugOverlap?: () => ReturnType<typeof debugRuntime.getSnapshot>['metrics'] | undefined
    __shiftObserver?: PerformanceObserver
  }
}

installOverlap()
createRoot(document.getElementById('app')!).render(<OverlapHost />)
